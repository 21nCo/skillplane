#!/usr/bin/env node

import {
  backfillLegacyPublicSkillProjections,
  migrateLegacyWorkspaceBatch,
} from "../packages/control-plane/dist/index.js";
import { migrateDatabase } from "../packages/db/dist/src/index.js";
import { Pool } from "pg";
import {
  isMain,
  productionBucket,
  productionStateDirectory,
  readJson,
  requireCleanSourceRevision,
  requireEnvironment,
} from "./lib/production-deployment.mjs";
import {
  assertRecentTopologyBackup,
  productionTopologyDatabases,
  verifyProductionTopologyDatabaseOwnership,
  writeTopologyMigrationSafetyState,
} from "./lib/production-topology-safety.mjs";
import { readProductionTopology } from "./lib/topology-deployment.mjs";
import {
  requireBucketName,
  WranglerR2MigrationStore,
} from "./lib/wrangler-r2-migration-store.mjs";

function regionBucketEnvironment(regionId) {
  return `SKILLPLANE_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_BUCKET`;
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
  const backup = assertRecentTopologyBackup(
    options.backup ?? (await readJson(`${productionStateDirectory}/backup.json`)),
    databases.control,
  );
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

  const preparedControl = await migrateDatabase(controlUrl, {
    role: "control",
    initialWorkspaceRegion: "legacy",
    finalizePhysicalOwnership: false,
  });
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
      const sourceObjects =
        options.sourceObjects ??
        new WranglerR2MigrationStore(
          requireBucketName(
            options.legacyBucketName ??
              process.env.SKILLPLANE_LEGACY_BUCKET ??
              productionBucket,
            "SKILLPLANE_LEGACY_BUCKET",
          ),
        );
      const regionalObjects =
        options.regionalObjects ??
        new WranglerR2MigrationStore(
          requireBucketName(
            options.initialCellBucketName ??
              requireEnvironment(regionBucketEnvironment(initialWorkspaceRegion)),
            regionBucketEnvironment(initialWorkspaceRegion),
          ),
        );
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
      const incomplete = await controlPool.query(
        `SELECT count(*)::text AS count
           FROM workspace_placements
          WHERE state <> 'active' OR region_id <> $1`,
        [initialWorkspaceRegion],
      );
      if (incomplete.rows[0]?.count !== "0") {
        throw new Error("TOPOLOGY_CUTOVER_PLACEMENTS_INCOMPLETE");
      }
      await controlPool.query(
        `UPDATE topology_cutover_state
            SET state = 'complete', target_region_id = $1,
                completed_at = now(), updated_at = now()
          WHERE id = 'legacy-to-cells' AND state = 'copying'`,
        [initialWorkspaceRegion],
      );
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
    backup,
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
