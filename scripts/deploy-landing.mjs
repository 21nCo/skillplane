#!/usr/bin/env node

import {
  deployNamedWorker,
  ensureCloudflareSession,
  verifyProductionHyperdrive,
} from "./lib/cloudflare-production.mjs";
import {
  assertRecentDatabaseSafetyState,
  isMain,
  requireCleanSourceRevision,
} from "./lib/production-deployment.mjs";
import { renderDeploymentConfigs } from "./render-deploy-config.mjs";

export async function deployLanding() {
  const safety = await assertRecentDatabaseSafetyState();
  requireCleanSourceRevision();
  await renderDeploymentConfigs();
  ensureCloudflareSession();
  verifyProductionHyperdrive(safety.database.identity);
  return deployNamedWorker("landing");
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await deployLanding(), null, 2)}\n`);
}
