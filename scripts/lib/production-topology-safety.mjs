import { resolve } from "node:path";
import { Pool } from "pg";
import {
  parseDirectPostgresUrl,
  postgresTlsEvidence,
  productionDatabase,
  productionStateDirectory,
  readJson,
  requireEnvironment,
  sha256,
  writeJsonAtomic,
} from "./production-deployment.mjs";

const backupMaximumAge = 24 * 60 * 60 * 1000;
const migrationMaximumAge = 2 * 60 * 60 * 1000;

export const topologyMigrationStatePath = resolve(
  productionStateDirectory,
  "topology-migration.json",
);

export function topologyCellEnvironment(regionId, suffix) {
  return `SKILLPLANE_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_${suffix}`;
}

function fingerprints(databases) {
  return {
    control: databases.control.fingerprint,
    cells: Object.fromEntries(
      Object.entries(databases.cells).map(([regionId, database]) => [
        regionId,
        database.fingerprint,
      ]),
    ),
  };
}

export function productionTopologyDatabases(manifest, options = {}) {
  const control = parseDirectPostgresUrl(
    options.controlDatabaseUrl ?? requireEnvironment("SKILLPLANE_CONTROL_DATABASE_URL"),
    "SKILLPLANE_CONTROL_DATABASE_URL",
  );
  const canonical = options.productionDatabase ?? productionDatabase();
  if (canonical.fingerprint !== control.fingerprint) {
    throw new Error(
      "SKILLPLANE_PRODUCTION_DATABASE_URL must identify the topology control database",
    );
  }
  const cells = Object.fromEntries(
    manifest.cells.map((cell) => {
      const environment = topologyCellEnvironment(cell.regionId, "DATABASE_URL");
      return [
        cell.regionId,
        parseDirectPostgresUrl(
          options.cells?.[cell.regionId] ?? requireEnvironment(environment),
          environment,
        ),
      ];
    }),
  );
  const all = [control, ...Object.values(cells)];
  if (new Set(all.map((database) => database.fingerprint)).size !== all.length) {
    throw new Error("Control and cell databases must be distinct");
  }
  return { control, cells };
}

export function assertRecentTopologyBackup(backup, control, now = Date.now()) {
  const createdAt = Date.parse(backup?.createdAt);
  if (
    backup?.ok !== true ||
    backup.databaseFingerprint !== control.fingerprint ||
    backup.restoreListVerified !== true ||
    typeof backup.encryptedSha256 !== "string" ||
    !Number.isFinite(createdAt) ||
    now - createdAt < 0 ||
    now - createdAt > backupMaximumAge
  ) {
    throw new Error(
      "A recent verified backup of the topology control database is required",
    );
  }
  return backup;
}

export function createTopologyMigrationSafetyState(input) {
  return {
    schemaVersion: 1,
    ok: true,
    createdAt: input.createdAt ?? new Date().toISOString(),
    applicationCommit: input.sourceRevision.commit,
    topologySha256: sha256(JSON.stringify(input.manifest)),
    databaseFingerprints: fingerprints(input.databases),
    backupSha256: input.backup.encryptedSha256,
    backupCreatedAt: input.backup.createdAt,
    controlRole: input.control.role,
    cellRoles: Object.fromEntries(
      Object.entries(input.cells).map(([regionId, result]) => [regionId, result.role]),
    ),
    cutoverComplete: input.cutoverComplete,
  };
}

export function assertRecentTopologyMigrationState(input) {
  const { state, backup, manifest, databases, sourceRevision } = input;
  const now = input.now ?? Date.now();
  const createdAt = Date.parse(state?.createdAt);
  const expectedFingerprints = fingerprints(databases);
  const expectedCells = Object.fromEntries(
    manifest.cells.map((cell) => [cell.regionId, "regional"]),
  );
  if (
    state?.schemaVersion !== 1 ||
    state.ok !== true ||
    state.applicationCommit !== sourceRevision.commit ||
    state.topologySha256 !== sha256(JSON.stringify(manifest)) ||
    JSON.stringify(state.databaseFingerprints) !==
      JSON.stringify(expectedFingerprints) ||
    state.backupSha256 !== backup.encryptedSha256 ||
    state.backupCreatedAt !== backup.createdAt ||
    state.controlRole !== "control" ||
    JSON.stringify(state.cellRoles) !== JSON.stringify(expectedCells) ||
    state.cutoverComplete !== true ||
    !Number.isFinite(createdAt) ||
    now - createdAt < 0 ||
    now - createdAt > migrationMaximumAge
  ) {
    throw new Error(
      "Topology migration safety evidence is stale or does not match this commit and resource set",
    );
  }
  return state;
}

async function databaseRelations(database, applicationName) {
  const pool = new Pool({
    connectionString: database.url,
    application_name: applicationName,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const client = await pool.connect();
    try {
      const [ssl, tables] = await Promise.all([
        client.query(
          "SELECT ssl, version, cipher, bits FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
        ),
        client.query(
          `SELECT table_name
             FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name`,
        ),
      ]);
      return {
        pool,
        tables: new Set(tables.rows.map((row) => row.table_name)),
        tls: postgresTlsEvidence(client, ssl.rows[0]),
      };
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end();
    throw error;
  }
}

function requireTables(tables, required, label) {
  for (const table of required) {
    if (!tables.has(table)) throw new Error(`${label}_TABLE_MISSING:${table}`);
  }
}

function forbidTables(tables, forbidden, label) {
  for (const table of forbidden) {
    if (tables.has(table)) throw new Error(`${label}_TABLE_PRESENT:${table}`);
  }
}

export async function verifyProductionTopologyDatabaseOwnership(manifest, databases) {
  const control = await databaseRelations(
    databases.control,
    "skillplane-production-topology-control-preflight",
  );
  try {
    requireTables(
      control.tables,
      ["authfn_users", "workspaces", "workspace_placements", "topology_cutover_state"],
      "CONTROL",
    );
    forbidTables(control.tables, ["skills", "regional_projection_outbox"], "CONTROL");
    const allowedRegions = manifest.cells.map((cell) => cell.regionId);
    const cutover = await control.pool.query(
      `SELECT state, target_region_id
         FROM topology_cutover_state
        WHERE id = 'legacy-to-cells'`,
    );
    if (
      cutover.rows[0]?.state !== "complete" ||
      !allowedRegions.includes(cutover.rows[0]?.target_region_id)
    ) {
      throw new Error("TOPOLOGY_CUTOVER_INCOMPLETE");
    }
    const placements = await control.pool.query(
      `SELECT count(*)::integer AS count
         FROM workspaces AS workspace
         LEFT JOIN workspace_placements AS placement
           ON placement.workspace_id = workspace.id
        WHERE placement.workspace_id IS NULL
           OR placement.state <> 'active'
           OR NOT (placement.region_id = ANY($1::text[]))`,
      [allowedRegions],
    );
    if (Number(placements.rows[0]?.count ?? 0) !== 0) {
      throw new Error("TOPOLOGY_WORKSPACE_PLACEMENT_INVALID");
    }
  } finally {
    await control.pool.end();
  }

  const cells = {};
  for (const cell of manifest.cells) {
    const regional = await databaseRelations(
      databases.cells[cell.regionId],
      `skillplane-production-topology-${cell.regionId}-preflight`,
    );
    try {
      requireTables(
        regional.tables,
        ["skills", "skill_versions", "regional_projection_outbox"],
        `CELL_${cell.regionId}`,
      );
      forbidTables(
        regional.tables,
        ["authfn_users", "workspaces", "workspace_placements"],
        `CELL_${cell.regionId}`,
      );
      cells[cell.regionId] = {
        tableCount: regional.tables.size,
        tls: regional.tls,
      };
    } finally {
      await regional.pool.end();
    }
  }
  return {
    control: { tableCount: control.tables.size, tls: control.tls },
    cells,
  };
}

export async function readAndAssertTopologySafety(input) {
  const now = input.now ?? Date.now();
  const backup = assertRecentTopologyBackup(
    input.backup ?? (await readJson(resolve(productionStateDirectory, "backup.json"))),
    input.databases.control,
    now,
  );
  const state = assertRecentTopologyMigrationState({
    state: input.state ?? (await readJson(topologyMigrationStatePath)),
    backup,
    manifest: input.manifest,
    databases: input.databases,
    sourceRevision: input.sourceRevision,
    now,
  });
  const ownership = await verifyProductionTopologyDatabaseOwnership(
    input.manifest,
    input.databases,
  );
  return { backup, migration: state, ownership };
}

export async function writeTopologyMigrationSafetyState(input) {
  const state = createTopologyMigrationSafetyState(input);
  await writeJsonAtomic(topologyMigrationStatePath, state, { mode: 0o600 });
  return state;
}
