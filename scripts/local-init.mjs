#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readWorkerDevelopmentVariables,
  updateWorkerDevelopmentVariables,
} from "./lib/local-worker-vars.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = join(repoRoot, ".data", "local-runtime.json");
const turnstileTestSiteKey = "1x00000000000000000000AA";
const turnstileTestSecret = "1x0000000000000000000000000000000AA";

function generateSecret() {
  return randomBytes(48).toString("base64url");
}

function validateSecret(name, value) {
  if (typeof value !== "string" || value.length < 32 || new Set(value).size < 10) {
    throw new Error(`${name} must contain at least 32 characters of secret material`);
  }
  return value;
}

function existingOrGenerated(name, current, generated, retained) {
  if (current !== undefined) {
    retained.push(name);
    return validateSecret(name, current);
  }
  generated.push(name);
  return generateSecret();
}

export function selectSharedOAuthPepper(appValue, mcpValue, generated, retained) {
  if (appValue !== undefined && mcpValue !== undefined && appValue !== mcpValue) {
    throw new Error(
      "OAUTH_TOKEN_PEPPER differs between app/.dev.vars and mcp/.dev.vars",
    );
  }
  return existingOrGenerated(
    "OAUTH_TOKEN_PEPPER",
    appValue ?? mcpValue,
    generated,
    retained,
  );
}

export function selectTurnstileCredentials(siteKey, secretKey, generated, retained) {
  if ((siteKey === undefined) !== (secretKey === undefined)) {
    throw new Error(
      "PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be configured together",
    );
  }
  if (siteKey !== undefined && secretKey !== undefined) {
    if (siteKey.length < 10) {
      throw new Error("PUBLIC_TURNSTILE_SITE_KEY is invalid");
    }
    const officialTestPair =
      siteKey === turnstileTestSiteKey && secretKey === turnstileTestSecret;
    if (!officialTestPair) {
      validateSecret("TURNSTILE_SECRET_KEY", secretKey);
    }
    retained.push("PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY");
    return { siteKey, secretKey };
  }
  generated.push("PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY");
  return {
    siteKey: turnstileTestSiteKey,
    secretKey: turnstileTestSecret,
  };
}

async function readVariables(path) {
  try {
    return readWorkerDevelopmentVariables(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}

async function readRuntime() {
  let runtime;
  try {
    runtime = JSON.parse(await readFile(runtimePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Local runtime is missing; run pnpm db:up first", {
        cause: error,
      });
    }
    throw new Error("Local runtime configuration is unreadable", { cause: error });
  }
  if (
    runtime?.port === undefined ||
    typeof runtime.databaseUrl !== "string" ||
    !runtime.databaseUrl.startsWith("postgres")
  ) {
    throw new Error("Local runtime configuration is invalid");
  }
  return runtime;
}

export async function initializeLocalEnvironment() {
  const runtime = await readRuntime();
  const appPath = join(repoRoot, "app", ".dev.vars");
  const mcpPath = join(repoRoot, "mcp", ".dev.vars");
  const [appVariables, mcpVariables] = await Promise.all([
    readVariables(appPath),
    readVariables(mcpPath),
  ]);
  const generated = [];
  const retained = [];
  const authfnSecret = existingOrGenerated(
    "AUTHFN_SECRET",
    appVariables.get("AUTHFN_SECRET"),
    generated,
    retained,
  );
  const oauthTokenPepper = selectSharedOAuthPepper(
    appVariables.get("OAUTH_TOKEN_PEPPER"),
    mcpVariables.get("OAUTH_TOKEN_PEPPER"),
    generated,
    retained,
  );
  const turnstile = selectTurnstileCredentials(
    appVariables.get("PUBLIC_TURNSTILE_SITE_KEY"),
    appVariables.get("TURNSTILE_SECRET_KEY"),
    generated,
    retained,
  );

  const databaseVariables = {
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: runtime.databaseUrl,
  };
  await updateWorkerDevelopmentVariables(appPath, {
    ...databaseVariables,
    AUTHFN_SECRET: authfnSecret,
    OAUTH_TOKEN_PEPPER: oauthTokenPepper,
    PUBLIC_TURNSTILE_SITE_KEY: turnstile.siteKey,
    TURNSTILE_SECRET_KEY: turnstile.secretKey,
  });
  await updateWorkerDevelopmentVariables(mcpPath, {
    ...databaseVariables,
    OAUTH_TOKEN_PEPPER: oauthTokenPepper,
  });

  return {
    ok: true,
    files: ["app/.dev.vars", "mcp/.dev.vars"],
    generated: [...new Set(generated)].sort(),
    retained: [...new Set(retained)].sort(),
    valuesPrinted: false,
    mode: "0600",
    defaultAuthentication: "disabled",
    authenticatedDevelopmentCommand: "pnpm dev:app:auth",
  };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(
    `${JSON.stringify(await initializeLocalEnvironment(), null, 2)}\n`,
  );
}
