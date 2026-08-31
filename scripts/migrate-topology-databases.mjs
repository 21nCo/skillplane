#!/usr/bin/env node

import { dirname } from "node:path";
import {
  backfillLegacyPublicSkillProjections,
  migrateLegacyWorkspaceBatch,
} from "../packages/control-plane/dist/index.js";
import { migrateDatabase } from "../packages/db/dist/src/index.js";
import { Pool } from "pg";
import {
  isMain,
  productionBucket,
  requireCleanSourceRevision,
  requireEnvironment,
  requireSecretEnvironment,
} from "./lib/production-deployment.mjs";
import {
  assertRecentTopologyBackups,
  productionTopologyDatabases,
  topologyBackupStatePath,
  verifyProductionTopologyDatabaseOwnership,
  writeTopologyMigrationSafetyState,
} from "./lib/production-topology-safety.mjs";
import { backupProductionDatabase } from "./production-backup.mjs";
import { readProductionTopology } from "./lib/topology-deployment.mjs";
import {
  requireBucketName,
  WranglerR2MigrationStore,
} from "./lib/wrangler-r2-migration-store.mjs";

function regionBucketEnvironment(regionId) {
  return `SKILLPLANE_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_BUCKET`;
}

export function assertDistinctTopologyCutoverBuckets(
  legacyBucketName,
  initialCellBucketName,
) {
  if (legacyBucketName === initialCellBucketName) {
    throw new Error(
      "SKILLPLANE_LEGACY_BUCKET and the initial cell bucket must be distinct",
    );
  }
  return { legacyBucketName, initialCellBucketName };
}

export async function prepareLegacyControlDatabase(
  databaseUrl,
  migrate = migrateDatabase,
) {
  // The legacy database remains the regional copy source until cutover. Apply
  // every source-side fence/outbox migration before switching its ownership
  // role to control and eventually pruning regional tables.
  await migrate(databaseUrl, {
    role: "combined",
    initialWorkspaceRegion: "legacy",
    finalizePhysicalOwnership: false,
  });
  return migrate(databaseUrl, {
    role: "control",
    initialWorkspaceRegion: "legacy",
    finalizePhysicalOwnership: false,
  });
}

async function prepareRegionalDatabase(databaseUrl, regionId) {
  await migrateDatabase(databaseUrl, {
    role: "regional",
    finalizePhysicalOwnership: false,
  });
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: `skillplane-topology-cell-safety-${regionId}`,
    max: 1,
  });
  try {
    const relation = await pool.query(
      "SELECT to_regclass('public.workspaces')::text AS workspaces_table",
    );
    if (relation.rows[0]?.workspaces_table) {
      const workspaces = await pool.query(
        "SELECT count(*)::text AS count FROM workspaces",
      );
      if (workspaces.rows[0]?.count !== "0") {
        throw new Error(`TOPOLOGY_CELL_GLOBAL_DATA_PRESENT:${regionId}`);
      }
    }
  } finally {
    await pool.end();
  }
  return migrateDatabase(databaseUrl, { role: "regional" });
}

export async function backupTopologyDatabases(databases, options = {}) {
  const backup = options.backupDatabase ?? backupProductionDatabase;
  const passphrase =
    options.passphrase ?? requireSecretEnvironment("SKILLPLANE_BACKUP_ENCRYPTION_KEY");
  const control = await backup({
    database: databases.control,
    passphrase,
    stateDirectory: dirname(topologyBackupStatePath()),
  });
  const cells = {};
  for (const [regionId, database] of Object.entries(databases.cells)) {
    cells[regionId] = await backup({
      database,
      passphrase,
      stateDirectory: dirname(topologyBackupStatePath(regionId)),
    });
  }
  return assertRecentTopologyBackups({ control, cells }, databases);
}

export async function completeTopologyCutover(controlPool, targetRegionId) {
  const client = await controlPool.connect();
  try {
    await client.query("BEGIN");
    const state = await client.query(
      `SELECT state
         FROM topology_cutover_state
        WHERE id = 'legacy-to-cells'
        FOR UPDATE`,
    );
    if (state.rows[0]?.state !== "copying") {
      throw new Error("TOPOLOGY_CUTOVER_NOT_COPYING");
    }
    const incomplete = await client.query(
      `SELECT count(*)::text AS count
         FROM workspaces workspace
         LEFT JOIN workspace_placements placement
           ON placement.workspace_id = workspace.id
        WHERE placement.workspace_id IS NULL
           OR placement.state <> 'active'
           OR placement.region_id <> $1`,
      [targetRegionId],
    );
    if (incomplete.rows[0]?.count !== "0") {
      throw new Error("TOPOLOGY_CUTOVER_PLACEMENTS_INCOMPLETE");
    }
    const completed = await client.query(
      `UPDATE topology_cutover_state
          SET state = 'complete', target_region_id = $1,
              completed_at = now(), updated_at = now()
        WHERE id = 'legacy-to-cells' AND state = 'copying'
        RETURNING id`,
      [targetRegionId],
    );
    if (completed.rowCount !== 1) {
      throw new Error("TOPOLOGY_CUTOVER_COMPLETION_CONFLICT");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateTopologyDatabases(options = {}) {
  const manifest = options.manifest ?? (await readProductionTopology());
  const sourceRevision = options.sourceRevision ?? requireCleanSourceRevision();
  const databases =
    options.databases ??
    productionTopologyDatabases(manifest, {
      controlDatabaseUrl: options.controlDatabaseUrl,
      cells: options.cells,
      productionDatabase: options.productionDatabase,
    });
  // Capture and verify every database before the first schema or data mutation.
  // The resulting digests are bound into the exact-commit migration evidence.
  const backups = await backupTopologyDatabases(databases, {
    backupDatabase: options.backupDatabase,
    passphrase: options.backupPassphrase,
  });
  const controlUrl = databases.control.url;
  const initialWorkspaceRegion = manifest.cells[0]?.regionId;
  if (!initialWorkspaceRegion) {
    throw new Error("The topology must declare an initial workspace cell");
  }
  const cellUrls = Object.fromEntries(
    manifest.cells.map((cell) => [cell.regionId, databases.cells[cell.regionId].url]),
  );

  const cells = {};
  for (const cell of manifest.cells) {
    cells[cell.regionId] = await prepareRegionalDatabase(
      cellUrls[cell.regionId],
      cell.regionId,
    );
  }

  const preparedControl = await prepareLegacyControlDatabase(controlUrl);
  const controlPool = new Pool({
    connectionString: controlUrl,
    application_name: "skillplane-topology-cutover-control",
    max: 3,
  });
  const targetPool = new Pool({
    connectionString: cellUrls[initialWorkspaceRegion],
    application_name: "skillplane-topology-cutover-target",
    max: 3,
  });
  let cutover;
  let projection;
  let alreadyComplete = false;
  try {
    const state = await controlPool.query(
      `SELECT state,
              to_regclass('public.skills')::text AS regional_table
         FROM topology_cutover_state
        WHERE id = 'legacy-to-cells'`,
    );
    const current = state.rows[0];
    if (current?.state === "complete" && current.regional_table === null) {
      alreadyComplete = true;
    } else if (current?.state === "complete") {
      cutover = { migrated: [], verifiedExisting: [] };
      projection = { projected: 0 };
    } else {
      await controlPool.query(
        `UPDATE topology_cutover_state
            SET state = 'copying', target_region_id = $1,
                started_at = COALESCE(started_at, now()),
                completed_at = NULL, updated_at = now()
          WHERE id = 'legacy-to-cells'`,
        [initialWorkspaceRegion],
      );
      const cutoverBuckets = assertDistinctTopologyCutoverBuckets(
        requireBucketName(
          options.legacyBucketName ??
            process.env.SKILLPLANE_LEGACY_BUCKET ??
            productionBucket,
          "SKILLPLANE_LEGACY_BUCKET",
        ),
        requireBucketName(
          options.initialCellBucketName ??
            requireEnvironment(regionBucketEnvironment(initialWorkspaceRegion)),
          regionBucketEnvironment(initialWorkspaceRegion),
        ),
      );
      const sourceObjects =
        options.sourceObjects ??
        new WranglerR2MigrationStore(cutoverBuckets.legacyBucketName);
      const regionalObjects =
        options.regionalObjects ??
        new WranglerR2MigrationStore(cutoverBuckets.initialCellBucketName);
      const publicObjects =
        options.publicObjects ??
        new WranglerR2MigrationStore(
          requireBucketName(
            options.publicBucketName ??
              process.env.SKILLPLANE_PUBLIC_BUCKET ??
              "skillplane-public-bundles",
            "SKILLPLANE_PUBLIC_BUCKET",
          ),
        );
      cutover = await migrateLegacyWorkspaceBatch({
        control: controlPool,
        source: controlPool,
        target: targetPool,
        sourceObjects,
        targetObjects: regionalObjects,
        targetRegionId: initialWorkspaceRegion,
      });
      projection = await backfillLegacyPublicSkillProjections({
        control: controlPool,
        regional: targetPool,
        regionalObjects,
        publicObjects,
        regionId: initialWorkspaceRegion,
      });
      await completeTopologyCutover(controlPool, initialWorkspaceRegion);
    }
  } finally {
    await Promise.allSettled([controlPool.end(), targetPool.end()]);
  }

  const control = alreadyComplete
    ? preparedControl
    : await migrateDatabase(controlUrl, {
        role: "control",
        initialWorkspaceRegion,
      });
  await verifyProductionTopologyDatabaseOwnership(manifest, databases);
  const safety = await writeTopologyMigrationSafetyState({
    sourceRevision,
    manifest,
    databases,
    backups,
    control,
    cells,
    cutoverComplete: true,
  });
  return {
    ok: true,
    control,
    cells,
    cutover: cutover ?? { migrated: [], verifiedExisting: [] },
    projection: projection ?? { projected: 0 },
    alreadyComplete,
    safety,
  };
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await migrateTopologyDatabases(), null, 2)}\n`,
  );
}
