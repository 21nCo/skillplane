#!/usr/bin/env node

import { resolve } from "node:path";
import { Pool } from "pg";
import { migrateDatabase } from "../packages/db/dist/src/index.js";
import { backupProductionDatabase } from "./production-backup.mjs";
import {
  developmentTopologyDatabases,
  verifyDevelopmentTopologyDatabaseOwnership,
} from "./lib/development-topology-deployment.mjs";
import {
  isMain,
  requireEnvironment,
  requireSecretEnvironment,
  root,
} from "./lib/production-deployment.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function relationExists(pool, relation) {
  const result = await pool.query("SELECT to_regclass($1)::text AS relation", [
    `public.${relation}`,
  ]);
  return Boolean(result.rows[0]?.relation);
}

async function tableCount(pool) {
  const result = await pool.query(
    `SELECT count(*)::integer AS count
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export function assertDevelopmentControlDatabaseShape(input) {
  if (
    input.existingTables > 0 &&
    (!input.hasControlTables || input.hasRegionalTables)
  ) {
    throw new Error(
      "The development control database must be empty or already control-only",
    );
  }
}

export async function prepareDevelopmentTopologyDatabases(options = {}) {
  const databases = options.databases ?? developmentTopologyDatabases();
  const controlConfirmation =
    options.confirmControlDatabase ?? argument("--confirm-control-database");
  const regionalConfirmation =
    options.confirmRegionalizeDatabase ?? argument("--confirm-regionalize-database");
  if (controlConfirmation !== databases.control.identity.database) {
    throw new Error("The exact control database name confirmation is required");
  }
  if (regionalConfirmation !== databases.cells["in-south"].identity.database) {
    throw new Error(
      "The exact India database regionalization confirmation is required",
    );
  }

  const controlPool = new Pool({
    connectionString: databases.control.url,
    application_name: "skillplane-dev-topology-control-preflight",
    max: 1,
  });
  try {
    const existingTables = await tableCount(controlPool);
    const [hasControlTables, hasRegionalTables] = await Promise.all([
      relationExists(controlPool, "workspace_placements"),
      relationExists(controlPool, "skills"),
    ]);
    assertDevelopmentControlDatabaseShape({
      existingTables,
      hasControlTables,
      hasRegionalTables,
    });
  } finally {
    await controlPool.end();
  }

  const indiaPool = new Pool({
    connectionString: databases.cells["in-south"].url,
    application_name: "skillplane-dev-topology-india-preflight",
    max: 1,
  });
  let needsRegionalization;
  try {
    needsRegionalization = await relationExists(indiaPool, "authfn_users");
  } finally {
    await indiaPool.end();
  }
  let backup = null;
  if (needsRegionalization) {
    backup = await backupProductionDatabase({
      database: databases.cells["in-south"],
      passphrase: requireSecretEnvironment("SKILLPLANE_DEV_BACKUP_ENCRYPTION_KEY"),
      stateDirectory: resolve(root, ".data", "development", "topology"),
    });
  }

  const control = await migrateDatabase(databases.control.url, {
    role: "control",
    initialWorkspaceRegion: "in-south",
  });
  const cells = {};
  for (const [regionId, database] of Object.entries(databases.cells)) {
    cells[regionId] = await migrateDatabase(database.url, { role: "regional" });
  }
  const ownership = await verifyDevelopmentTopologyDatabaseOwnership(databases);
  return {
    ok: true,
    environment: "development",
    backup,
    control,
    cells,
    ownership,
  };
}

if (isMain(import.meta.url)) {
  requireEnvironment("SKILLPLANE_DEV_CONTROL_DATABASE_URL");
  process.stdout.write(
    `${JSON.stringify(await prepareDevelopmentTopologyDatabases(), null, 2)}\n`,
  );
}
