#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { updateWorkerDevelopmentVariables } from "./lib/local-worker-vars.mjs";
import { isMain } from "./lib/production-deployment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const statePath = join(root, ".data", "local-oauth.json");

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function canonicalHttps(value, label, path = undefined) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${label} must be an absolute HTTPS URL without credentials, query, or fragment`,
    );
  }
  if (path === undefined && parsed.pathname !== "/") {
    throw new Error(`${label} must use the origin root without a path`);
  }
  if (path !== undefined) parsed.pathname = path;
  return parsed.toString().replace(/\/$/u, "");
}

async function assertInitialized() {
  try {
    await readFile(join(root, ".data", "local-runtime.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Local runtime is missing; run pnpm db:up and pnpm local:init first",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function configureLocalOAuth(options = {}) {
  await assertInitialized();
  const { issuer, resource } = normalizeLocalOAuthUrls(
    options.appUrl ?? argument("app-url") ?? process.env.SKILLPLANE_LOCAL_APP_URL,
    options.mcpUrl ?? argument("mcp-url") ?? process.env.SKILLPLANE_LOCAL_MCP_URL,
  );
  const shared = {
    OAUTH_ISSUER: issuer,
    OAUTH_RESOURCE: resource,
  };
  await updateWorkerDevelopmentVariables(join(root, "app", ".dev.vars"), {
    ...shared,
    TURNSTILE_ALLOWED_HOSTNAMES: [
      "localhost",
      "127.0.0.1",
      new URL(issuer).hostname,
    ].join(","),
  });
  await updateWorkerDevelopmentVariables(join(root, "mcp", ".dev.vars"), shared);
  const state = {
    schemaVersion: 1,
    configuredAt: new Date().toISOString(),
    issuer,
    resource,
    localOrigins: {
      app: "http://127.0.0.1:5700",
      mcp: "http://127.0.0.1:5701",
    },
  };
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    ok: true,
    issuer,
    resource,
    files: ["app/.dev.vars", "mcp/.dev.vars", ".data/local-oauth.json"],
    next: ["pnpm dev:app:auth", "pnpm dev:mcp", "pnpm test:local:oauth"],
  };
}

export function normalizeLocalOAuthUrls(appUrl, mcpUrl) {
  const issuer = canonicalHttps(appUrl, "Local app URL");
  const resource = canonicalHttps(mcpUrl, "Local MCP URL", "/mcp");
  if (new URL(issuer).origin === new URL(resource).origin) {
    throw new Error("Local app and MCP tunnel URLs must use distinct hostnames");
  }
  return { issuer, resource };
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await configureLocalOAuth(), null, 2)}\n`);
}
