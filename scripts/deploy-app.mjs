#!/usr/bin/env node

import {
  deployNamedWorker,
  ensureCloudflareSession,
  ensureProductionBucket,
  verifyProductionHyperdrive,
} from "./lib/cloudflare-production.mjs";
import {
  assertRecentDatabaseSafetyState,
  isMain,
  requireCleanSourceRevision,
} from "./lib/production-deployment.mjs";
import { renderDeploymentConfigs } from "./render-deploy-config.mjs";

export async function deployApp() {
  const safety = await assertRecentDatabaseSafetyState();
  requireCleanSourceRevision();
  await renderDeploymentConfigs();
  ensureCloudflareSession();
  verifyProductionHyperdrive(safety.database.identity);
  ensureProductionBucket();
  return deployNamedWorker("app");
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await deployApp(), null, 2)}\n`);
}
