#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  deployNamedWorker,
  ensureCloudflareSession,
  ensureProductionBucket,
  verifyProductionHyperdrive,
} from "./lib/cloudflare-production.mjs";
import {
  assertRecentDatabaseSafetyState,
  capture,
  isMain,
  portablePath,
  productionReleaseTag,
  productionSecrets,
  requireCleanSourceRevision,
  requireHyperdriveId,
  root,
  run,
  sanitizeDeploymentRecord,
  sha256,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";
import { productionSmoke } from "./production-smoke.mjs";
import { renderDeploymentConfigs } from "./render-deploy-config.mjs";

async function releaseSourceDigest() {
  const files = new Set([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "turbo.json",
    "tsconfig.base.json",
  ]);
  const listed = capture("rg", [
    "--files",
    "app",
    "landing",
    "mcp",
    "packages",
    "scripts",
    "deployment",
  ]);
  for (const path of listed.stdout?.split("\n") ?? []) {
    if (path) files.add(path);
  }
  const source = await Promise.all(
    [...files]
      .sort()
      .map(async (path) => [path, sha256(await readFile(resolve(root, path)))]),
  );
  return sha256(JSON.stringify(source));
}

export async function deployAll() {
  const startedAt = new Date().toISOString();
  const tag = productionReleaseTag();

  // Resolve every local prerequisite before the first Cloudflare mutation.
  const hyperdriveId = requireHyperdriveId();
  productionSecrets();
  const database = await assertRecentDatabaseSafetyState();
  const sourceRevision = requireCleanSourceRevision();
  const sourceDigest = await releaseSourceDigest();
  const rendered = await renderDeploymentConfigs();
  ensureCloudflareSession();
  const hyperdrive = verifyProductionHyperdrive(database.database.identity);
  run("pnpm", ["build"], { failureMessage: "Production monorepo build failed" });

  const r2 = ensureProductionBucket();
  const progressPath = resolve(root, ".data", "production", "release-in-progress.json");
  const workerDeployments = {};
  for (const kind of ["app", "mcp", "landing"]) {
    workerDeployments[kind] = await deployNamedWorker(kind, {
      build: false,
      tag,
    });
    await writeJsonAtomic(
      progressPath,
      sanitizeDeploymentRecord({
        ok: false,
        startedAt,
        tag,
        completedWorkers: Object.keys(workerDeployments),
        workers: workerDeployments,
      }),
      { mode: 0o600 },
    );
  }
  const smoke = await productionSmoke({ attempts: 90 });
  const finalSourceRevision = requireCleanSourceRevision();
  const finalSourceDigest = await releaseSourceDigest();
  if (
    finalSourceRevision.commit !== sourceRevision.commit ||
    finalSourceDigest !== sourceDigest
  ) {
    throw new Error("Skillplane source changed during production deployment");
  }
  const manifest = sanitizeDeploymentRecord({
    schemaVersion: 1,
    ok: true,
    environment: "production",
    startedAt,
    completedAt: new Date().toISOString(),
    tag,
    applicationCommit: sourceRevision.commit,
    sourceDigest,
    topology: {
      databaseOrigin: "railway-postgres",
      workerDatabasePath: "cloudflare-hyperdrive",
      runtimeDirectDatabaseUrl: false,
      hosts: {
        landing: "https://skillplane.dev",
        app: "https://app.skillplane.dev",
        mcp: "https://mcp.skillplane.dev",
      },
    },
    bindings: {
      hyperdrive: {
        binding: "HYPERDRIVE",
        id: hyperdriveId,
        railwayOriginMatched: hyperdrive.railwayOriginMatched,
        queryCacheDisabled: hyperdrive.queryCacheDisabled,
      },
      r2: { binding: "SKILL_BUNDLES", ...r2 },
      email: {
        binding: "SEND_EMAIL",
        provider: "cloudflare-email",
        sender: "no-reply@auth.skillplane.dev",
      },
      secretNames: {
        app: ["AUTHFN_SECRET", "OAUTH_TOKEN_PEPPER", "TURNSTILE_SECRET_KEY"],
        mcp: ["OAUTH_TOKEN_PEPPER"],
        landing: [],
      },
      turnstile: {
        siteKeyConfigured: true,
        allowedHostnames: ["app.skillplane.dev"],
      },
    },
    configs: rendered.configs,
    database: {
      fingerprint: database.database.fingerprint,
      backup: database.backup,
      migration: database.migration,
    },
    workers: workerDeployments,
    smoke,
  });
  const artifactName = `${startedAt.replaceAll(/[:.]/gu, "-")}-${tag}.json`;
  const manifestPath = resolve(root, ".conduct", "deployments", artifactName);
  await writeJsonAtomic(manifestPath, manifest, {
    mode: 0o600,
    exclusive: true,
  });
  const state = {
    ...manifest,
    manifest: portablePath(manifestPath),
  };
  await writeJsonAtomic(resolve(root, ".data", "production", "release.json"), state, {
    mode: 0o600,
  });
  return {
    ok: true,
    tag,
    manifest: portablePath(manifestPath),
    workers: workerDeployments,
    smoke,
  };
}

if (isMain(import.meta.url)) {
  const result = await deployAll();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
