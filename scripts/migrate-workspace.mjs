#!/usr/bin/env node

import { Pool } from "pg";
import {
  canFinalizeWorkspaceMigrationCompletion,
  PostgresWorkspaceMigrationJournal,
  PostgresWorkspaceMigrationOperations,
  createPostgresWorkspacePlacementDirectory,
  isWorkspaceMigrationRecoveryPending,
  migrateWorkspaceWithJournal,
  runWorkspaceRollbackDrill,
} from "../packages/control-plane/dist/index.js";
import {
  isMain,
  parseDirectPostgresUrl,
  requireEnvironment,
} from "./lib/production-deployment.mjs";
import {
  requireBucketName,
  WranglerR2MigrationStore,
} from "./lib/wrangler-r2-migration-store.mjs";

function bucketName(name) {
  return requireBucketName(requireEnvironment(name), name);
}

export function assertDistinctMigrationBuckets(sourceBucket, targetBucket) {
  if (sourceBucket === targetBucket) {
    throw new Error(
      "SKILLPLANE_SOURCE_BUCKET and SKILLPLANE_TARGET_BUCKET must be distinct",
    );
  }
  return { sourceBucket, targetBucket };
}

export function requiresWorkspaceRollbackDrill(placement) {
  return placement === null || !isWorkspaceMigrationRecoveryPending(placement);
}

export function assertDistinctMigrationDatabases(databases) {
  if (
    new Set(Object.values(databases).map(({ fingerprint }) => fingerprint)).size !== 3
  ) {
    throw new Error("Migration control, source, and target databases must be distinct");
  }
  return databases;
}

export function migrationSourceRegionId(placement) {
  if (!placement) {
    throw new Error("WORKSPACE_MIGRATION_SOURCE_NOT_ACTIVE");
  }
  if (!isWorkspaceMigrationRecoveryPending(placement)) {
    return placement.regionId;
  }
  return (
    placement.migration?.sourceRegionId ??
    placement.previousRegionId ??
    placement.regionId
  );
}

export function assertMigrationDatabaseRegions(input) {
  const sourceRegionId = migrationSourceRegionId(input.placement);
  if (sourceRegionId === input.targetRegionId) {
    throw new Error("Workspace migration source and target regions must be distinct");
  }
  const sourceDatabase = input.regionalDatabases[sourceRegionId];
  const targetDatabase = input.regionalDatabases[input.targetRegionId];
  if (
    !sourceDatabase ||
    input.databases.source.fingerprint !== sourceDatabase.fingerprint
  ) {
    throw new Error(
      `SKILLPLANE_SOURCE_DATABASE_URL must identify the ${sourceRegionId} cell database`,
    );
  }
  if (
    !targetDatabase ||
    input.databases.target.fingerprint !== targetDatabase.fingerprint
  ) {
    throw new Error(
      `SKILLPLANE_TARGET_DATABASE_URL must identify the ${input.targetRegionId} cell database`,
    );
  }
  return { sourceRegionId, targetRegionId: input.targetRegionId };
}

export function assertMigrationBucketRegions(input) {
  const expectedSource = input.regionalBuckets[input.sourceRegionId];
  const expectedTarget = input.regionalBuckets[input.targetRegionId];
  if (!expectedSource || input.buckets.sourceBucket !== expectedSource) {
    throw new Error(
      `SKILLPLANE_SOURCE_BUCKET must name the ${input.sourceRegionId} cell bucket`,
    );
  }
  if (!expectedTarget || input.buckets.targetBucket !== expectedTarget) {
    throw new Error(
      `SKILLPLANE_TARGET_BUCKET must name the ${input.targetRegionId} cell bucket`,
    );
  }
  return { sourceRegionId: input.sourceRegionId, targetRegionId: input.targetRegionId };
}

function cellDatabaseEnvironment(regionId) {
  return `SKILLPLANE_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_DATABASE_URL`;
}

function cellBucketEnvironment(regionId) {
  return `SKILLPLANE_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_BUCKET`;
}

export async function migrateConfiguredWorkspace() {
  const workspaceId = requireEnvironment("SKILLPLANE_WORKSPACE_ID", {
    pattern: /^[A-Za-z0-9:_-]{1,180}$/u,
  });
  const targetRegionId = requireEnvironment("SKILLPLANE_TARGET_REGION_ID", {
    pattern: /^[a-z0-9][a-z0-9-]{0,62}$/u,
  });
  const buckets = assertDistinctMigrationBuckets(
    bucketName("SKILLPLANE_SOURCE_BUCKET"),
    bucketName("SKILLPLANE_TARGET_BUCKET"),
  );
  const databases = assertDistinctMigrationDatabases({
    control: parseDirectPostgresUrl(
      requireEnvironment("SKILLPLANE_CONTROL_DATABASE_URL"),
      "SKILLPLANE_CONTROL_DATABASE_URL",
    ),
    source: parseDirectPostgresUrl(
      requireEnvironment("SKILLPLANE_SOURCE_DATABASE_URL"),
      "SKILLPLANE_SOURCE_DATABASE_URL",
    ),
    target: parseDirectPostgresUrl(
      requireEnvironment("SKILLPLANE_TARGET_DATABASE_URL"),
      "SKILLPLANE_TARGET_DATABASE_URL",
    ),
  });
  const control = new Pool({
    connectionString: databases.control.url,
    application_name: "skillplane-workspace-migration-control",
    max: 2,
  });
  let source;
  let target;
  try {
    const directory = createPostgresWorkspacePlacementDirectory(control);
    const journal = new PostgresWorkspaceMigrationJournal(control);
    const placement = await directory.get(workspaceId);
    // When a previous run activated the target but failed its final journal
    // update, the placement is already active at the target region. Region
    // assertions and the rollback drill only apply to an actual data move;
    // a completion-pending run is finalized from its stored proof instead.
    const pendingCompletion = await journal.pendingCompletion(workspaceId);
    const finalizingCompletion = canFinalizeWorkspaceMigrationCompletion({
      placement,
      pending: pendingCompletion,
      workspaceId,
      targetRegionId,
    });
    if (!finalizingCompletion) {
      const sourceRegionId = migrationSourceRegionId(placement);
      const regionIds = [...new Set([sourceRegionId, targetRegionId])];
      const regionalDatabases = Object.fromEntries(
        regionIds.map((regionId) => {
          const environment = cellDatabaseEnvironment(regionId);
          return [
            regionId,
            parseDirectPostgresUrl(requireEnvironment(environment), environment),
          ];
        }),
      );
      assertMigrationDatabaseRegions({
        placement,
        targetRegionId,
        databases,
        regionalDatabases,
      });
      // The copied bundles are verified against the same buckets they are
      // written to, so a wrong-but-distinct bucket would pass every check while
      // the target cell reads from its own configured bucket. Bind both
      // buckets to their placement regions exactly like the databases above.
      const regionalBuckets = Object.fromEntries(
        regionIds.map((regionId) => {
          const environment = cellBucketEnvironment(regionId);
          return [regionId, bucketName(environment)];
        }),
      );
      assertMigrationBucketRegions({
        sourceRegionId,
        targetRegionId,
        buckets,
        regionalBuckets,
      });
    }
    source = new Pool({
      connectionString: databases.source.url,
      application_name: "skillplane-workspace-migration-source",
      max: 2,
    });
    target = new Pool({
      connectionString: databases.target.url,
      application_name: "skillplane-workspace-migration-target",
      max: 2,
    });
    const operations = new PostgresWorkspaceMigrationOperations(
      source,
      target,
      control,
      new WranglerR2MigrationStore(buckets.sourceBucket),
      new WranglerR2MigrationStore(buckets.targetBucket),
    );
    if (!finalizingCompletion && requiresWorkspaceRollbackDrill(placement)) {
      await runWorkspaceRollbackDrill({
        directory,
        workspaceId,
        targetRegionId,
        operations,
      });
    }
    return await migrateWorkspaceWithJournal({
      directory,
      journal,
      workspaceId,
      targetRegionId,
      operations,
      rollbackTested: true,
    });
  } finally {
    await Promise.allSettled(
      [source, target, control].filter(Boolean).map((pool) => pool.end()),
    );
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify({ ok: true, ...(await migrateConfiguredWorkspace()) }, null, 2)}\n`,
  );
}
