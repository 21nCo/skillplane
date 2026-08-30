#!/usr/bin/env node

import { Pool } from "pg";
import {
  PostgresWorkspaceMigrationJournal,
  PostgresWorkspaceMigrationOperations,
  createPostgresWorkspacePlacementDirectory,
  migrateWorkspaceWithJournal,
  runWorkspaceRollbackDrill,
} from "../packages/control-plane/dist/index.js";
import { isMain, requireEnvironment } from "./lib/production-deployment.mjs";
import {
  requireBucketName,
  WranglerR2MigrationStore,
} from "./lib/wrangler-r2-migration-store.mjs";

function bucketName(name) {
  return requireBucketName(requireEnvironment(name), name);
}

export async function migrateConfiguredWorkspace() {
  const workspaceId = requireEnvironment("SKILLPLANE_WORKSPACE_ID", {
    pattern: /^[A-Za-z0-9:_-]{1,180}$/u,
  });
  const targetRegionId = requireEnvironment("SKILLPLANE_TARGET_REGION_ID", {
    pattern: /^[a-z0-9][a-z0-9-]{0,62}$/u,
  });
  const control = new Pool({
    connectionString: requireEnvironment("SKILLPLANE_CONTROL_DATABASE_URL"),
    application_name: "skillplane-workspace-migration-control",
    max: 2,
  });
  const source = new Pool({
    connectionString: requireEnvironment("SKILLPLANE_SOURCE_DATABASE_URL"),
    application_name: "skillplane-workspace-migration-source",
    max: 2,
  });
  const target = new Pool({
    connectionString: requireEnvironment("SKILLPLANE_TARGET_DATABASE_URL"),
    application_name: "skillplane-workspace-migration-target",
    max: 2,
  });
  try {
    const operations = new PostgresWorkspaceMigrationOperations(
      source,
      target,
      control,
      new WranglerR2MigrationStore(bucketName("SKILLPLANE_SOURCE_BUCKET")),
      new WranglerR2MigrationStore(bucketName("SKILLPLANE_TARGET_BUCKET")),
    );
    const directory = createPostgresWorkspacePlacementDirectory(control);
    await runWorkspaceRollbackDrill({
      directory,
      workspaceId,
      targetRegionId,
      operations,
    });
    return await migrateWorkspaceWithJournal({
      directory,
      journal: new PostgresWorkspaceMigrationJournal(control),
      workspaceId,
      targetRegionId,
      operations,
      rollbackTested: true,
    });
  } finally {
    await Promise.allSettled([source.end(), target.end(), control.end()]);
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify({ ok: true, ...(await migrateConfiguredWorkspace()) }, null, 2)}\n`,
  );
}
