import { topologySecrets } from "./development-topology-secrets.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  GLOBAL_CONTROL_TABLES,
  REGIONAL_WORKSPACE_TABLES,
} from "../../packages/control-plane/dist/table-ownership.js";
import { loadMigrations } from "../../packages/db/dist/src/migrate.js";
import { renderDevelopmentTopologyConfigs } from "../render-development-topology-config.mjs";
import {
  developmentCloudflareEnvironment,
  developmentDatabase,
  ensurePrivateDevelopmentBucket,
  verifyDevelopmentHyperdrive,
} from "./development-deployment.mjs";
import {
  capture,
  captureWrangler,
  parseDirectPostgresUrl,
  requireEnvironment,
  root,
  run,
  writeJsonAtomic,
} from "./production-deployment.mjs";

const databaseVariables = Object.freeze({
  "in-south": "SKILLPLANE_DEV_DATABASE_URL",
  "us-east": "SKILLPLANE_DEV_USEAST_DATABASE_URL",
  "eu-west": "SKILLPLANE_DEV_EUWEST_DATABASE_URL",
});

// The first cell that received the converted combined development database.
export const developmentInitialWorkspaceRegion = "in-south";

// Every variable that can name a production database: the single-database
// names plus the production topology control and SKILLPLANE_CELL_<REGION>
// cell databases read by `db:migrate:topology` and `deploy:all`.
export function productionDatabaseVariables(environment = process.env) {
  return [
    "RAILWAY_DATABASE_URL",
    "SKILLPLANE_PRODUCTION_DATABASE_URL",
    "SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL",
    "SKILLPLANE_CONTROL_DATABASE_URL",
    ...Object.keys(environment)
      .filter((name) => /^SKILLPLANE_CELL_[A-Z0-9_]+_DATABASE_URL$/u.test(name))
      .sort(),
  ];
}

export const productionIdentitiesVariable = "SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES";

// Non-secret production database identities (`host[:port]/database`, separated
// by commas or whitespace) let an environment without production credentials,
// such as the development deploy job, still refuse a production database.
export function productionDatabaseIdentityFingerprints(environment = process.env) {
  const raw = environment[productionIdentitiesVariable]?.trim() ?? "";
  return raw
    .split(/[\s,]+/u)
    .filter(Boolean)
    .map((identity) => {
      if (
        !/^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?\/[^\s/?#@:]+$/iu.test(identity)
      ) {
        throw new Error(
          `${productionIdentitiesVariable} entries must be host[:port]/database without credentials`,
        );
      }
      return parseDirectPostgresUrl(
        `postgresql://identity:identity@${identity}`,
        productionIdentitiesVariable,
      ).fingerprint;
    });
}

// The production URL variables are only present where an operator happens to
// keep them (the development commands load only `.env.development.local`, and
// GitHub Actions has none), so comparing against them alone can compare against
// nothing. Every development migration therefore fails closed until the
// non-secret production identities are configured, on any host.
export function assertProductionIsolationConfigured(environment = process.env) {
  if (productionDatabaseIdentityFingerprints(environment).length === 0) {
    throw new Error(
      `PRODUCTION_ISOLATION_UNCONFIGURED: ${productionIdentitiesVariable} must list the production database identities`,
    );
  }
}

function assertNotProductionDatabase(database, name) {
  if (productionDatabaseIdentityFingerprints().includes(database.fingerprint)) {
    throw new Error(`${name} must differ from ${productionIdentitiesVariable}`);
  }
  for (const productionVariable of productionDatabaseVariables()) {
    const productionUrl = process.env[productionVariable]?.trim();
    if (
      productionUrl &&
      database.fingerprint ===
        parseDirectPostgresUrl(productionUrl, productionVariable).fingerprint
    ) {
      throw new Error(`${name} must differ from ${productionVariable}`);
    }
  }
  return database;
}

export function developmentTopologyDatabases() {
  const control = assertNotProductionDatabase(
    parseDirectPostgresUrl(
      requireEnvironment("SKILLPLANE_DEV_CONTROL_DATABASE_URL"),
      "SKILLPLANE_DEV_CONTROL_DATABASE_URL",
    ),
    "The development control database",
  );
  const cells = Object.fromEntries(
    Object.entries(databaseVariables).map(([regionId, variable]) => [
      regionId,
      assertNotProductionDatabase(
        regionId === developmentInitialWorkspaceRegion
          ? developmentDatabase()
          : parseDirectPostgresUrl(requireEnvironment(variable), variable),
        `The ${regionId} development database`,
      ),
    ]),
  );
  const all = [control, ...Object.values(cells)];
  if (new Set(all.map((database) => database.fingerprint)).size !== all.length) {
    throw new Error(
      "Development control and cell database identities must be distinct",
    );
  }
  return { control, cells };
}

async function relations(database) {
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-dev-topology-ownership",
    max: 1,
  });
  try {
    const result = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    return new Set(result.rows.map((row) => row.table_name));
  } finally {
    await pool.end();
  }
}

function migrationName(id) {
  return id.replace(/\.sql$/u, "");
}

// Compares one database's migration ledger with the code's migrations for its
// role. Returns the SCHEMA_BEHIND detail, or null when nothing is pending.
export function schemaHeadStatus(label, role, migrations, appliedIds) {
  const roleMigrations = migrations
    .filter((migration) => migration.roles.includes(role))
    .map((migration) => migration.id);
  if (roleMigrations.length === 0) {
    throw new Error(`No ${role} migrations found`);
  }
  const applied = new Set(appliedIds);
  const head = roleMigrations.at(-1);
  const pending = roleMigrations.filter((id) => !applied.has(id));
  const latestApplied = roleMigrations.filter((id) => applied.has(id)).at(-1);
  return {
    database: label,
    role,
    applied: latestApplied ? migrationName(latestApplied) : "none",
    head: migrationName(head),
    pending: pending.map(migrationName),
  };
}

async function appliedMigrationIds(database, label) {
  const pool = new Pool({
    connectionString: database.url,
    application_name: `skillplane-dev-topology-schema-${label}`,
    max: 1,
  });
  try {
    const ledger = await pool.query(
      "SELECT to_regclass('public.skillplane_schema_migrations')::text AS relation",
    );
    if (!ledger.rows[0]?.relation) return [];
    const result = await pool.query(
      "SELECT id FROM skillplane_schema_migrations ORDER BY id",
    );
    return result.rows.map((row) => row.id);
  } finally {
    await pool.end();
  }
}

// Reads every ledger before reporting, so one error names each database that
// is behind instead of the indirect CELL_TABLE_MISSING from the ownership check.
export async function verifyDevelopmentTopologySchemaHeads(databases, options = {}) {
  const migrations = options.migrations ?? (await loadMigrations());
  const targets = [
    ["control", "control", databases.control],
    ...Object.entries(databases.cells).map(([regionId, database]) => [
      regionId,
      "regional",
      database,
    ]),
  ];
  const statuses = [];
  for (const [label, role, database] of targets) {
    statuses.push(
      schemaHeadStatus(
        label,
        role,
        migrations,
        await appliedMigrationIds(database, label),
      ),
    );
  }
  const behind = statuses.filter((status) => status.pending.length > 0);
  if (behind.length > 0) {
    throw new Error(
      behind
        .map(
          (status) =>
            `SCHEMA_BEHIND:${status.database}:${status.applied}->${status.head}`,
        )
        .join("; "),
    );
  }
  return {
    control: { head: statuses[0].head },
    cells: Object.fromEntries(
      statuses.slice(1).map((status) => [status.database, { head: status.head }]),
    ),
  };
}

// The pre-upload database gate: schema heads first, then table ownership.
export async function verifyDevelopmentTopologyDatabases(databases, options = {}) {
  const schema = await verifyDevelopmentTopologySchemaHeads(databases, options);
  const ownership = await verifyDevelopmentTopologyDatabaseOwnership(databases);
  return { schema, ownership };
}

async function migrationState(database) {
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-dev-topology-preflight",
    max: 1,
  });
  try {
    const result = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const tables = new Set(result.rows.map((row) => row.table_name));
    const applied = tables.has("skillplane_schema_migrations")
      ? Number(
          (
            await pool.query(
              "SELECT count(*) AS count FROM skillplane_schema_migrations",
            )
          ).rows[0].count,
        )
      : 0;
    return { tables, applied };
  } finally {
    await pool.end();
  }
}

function notPrepared(label, detail) {
  return new Error(
    `TOPOLOGY_NOT_PREPARED:${label}:${detail} (run pnpm db:prepare:dev:topology first)`,
  );
}

// Read-only guard for in-place migrations, run against every database before
// any of them is migrated. Each database must already be converted: it has a
// migration ledger with at least one applied migration and no table of the
// other role. An empty database is refused too, because the early migrations
// apply to every role and only the one-time `db:prepare:dev:topology`
// conversion prunes the other role's tables afterwards.
export async function assertDevelopmentTopologyPrepared(databases) {
  const targets = [
    ["control", databases.control, REGIONAL_WORKSPACE_TABLES],
    ...Object.entries(databases.cells).map(([regionId, database]) => [
      regionId,
      database,
      GLOBAL_CONTROL_TABLES,
    ]),
  ];
  for (const [label, database, forbiddenTables] of targets) {
    const state = await migrationState(database);
    if (state.applied === 0) throw notPrepared(label, "empty");
    const forbidden = forbiddenTables.find((table) => state.tables.has(table));
    if (forbidden) throw notPrepared(label, forbidden);
  }
}

export async function verifyDevelopmentTopologyDatabaseOwnership(databases) {
  const control = await relations(databases.control);
  for (const required of GLOBAL_CONTROL_TABLES) {
    if (!control.has(required)) throw new Error(`CONTROL_TABLE_MISSING:${required}`);
  }
  for (const forbidden of REGIONAL_WORKSPACE_TABLES) {
    if (control.has(forbidden)) {
      throw new Error(`CONTROL_REGIONAL_TABLE_PRESENT:${forbidden}`);
    }
  }
  const cells = {};
  for (const [regionId, database] of Object.entries(databases.cells)) {
    const tables = await relations(database);
    for (const required of REGIONAL_WORKSPACE_TABLES) {
      if (!tables.has(required)) {
        throw new Error(`CELL_TABLE_MISSING:${regionId}:${required}`);
      }
    }
    for (const forbidden of GLOBAL_CONTROL_TABLES) {
      if (tables.has(forbidden)) {
        throw new Error(`CELL_CONTROL_TABLE_PRESENT:${regionId}:${forbidden}`);
      }
    }
    cells[regionId] = { tableCount: tables.size };
  }
  return { control: { tableCount: control.size }, cells };
}

async function withSecretFile(secrets, operation) {
  const directory = resolve(root, ".data", "development", "topology");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, `secrets-${randomUUID()}.json`);
  await writeJsonAtomic(path, secrets, { mode: 0o600 });
  try {
    return await operation(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

export function selectDevelopmentTopologyOutputs(outputs, onlyKinds) {
  const allowed = new Set(["app", "mcp", "projection", "datafn"]);
  if (
    onlyKinds &&
    (onlyKinds.length === 0 || onlyKinds.some((kind) => !allowed.has(kind)))
  ) {
    throw new Error("--only must contain app, mcp, projection, or datafn");
  }
  return outputs
    .filter((output) => !onlyKinds || onlyKinds.includes(output.kind))
    .sort(
      (left, right) =>
        Number(left.id.startsWith("gateway:")) -
        Number(right.id.startsWith("gateway:")),
    );
}

export async function deployDevelopmentTopology(options = {}) {
  const commit = capture("git", ["rev-parse", "HEAD"]).stdout.trim();
  const changes = capture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).stdout.trim();
  if (changes) {
    throw new Error(
      "Development topology deployment requires a committed clean worktree",
    );
  }
  const cloudflareEnvironment = developmentCloudflareEnvironment();
  const databases = developmentTopologyDatabases();
  const rendered = await renderDevelopmentTopologyConfigs();
  captureWrangler(["whoami"], { env: cloudflareEnvironment });
  const hyperdrives = {
    control: verifyDevelopmentHyperdrive(databases.control, {
      env: cloudflareEnvironment,
      hyperdriveId: rendered.resources.controlHyperdriveId,
    }),
    cells: Object.fromEntries(
      Object.entries(databases.cells).map(([regionId, database]) => [
        regionId,
        verifyDevelopmentHyperdrive(database, {
          env: cloudflareEnvironment,
          hyperdriveId: rendered.resources.cells[regionId].hyperdriveId,
        }),
      ]),
    ),
  };
  const { schema, ownership } = await verifyDevelopmentTopologyDatabases(databases);
  const bucketNames = new Set([
    rendered.resources.publicBucketName,
    ...Object.values(rendered.resources.cells).map((cell) => cell.bucketName),
  ]);
  const buckets = [];
  for (const bucketName of bucketNames) {
    buckets.push(
      ensurePrivateDevelopmentBucket(bucketName, { env: cloudflareEnvironment }),
    );
  }
  const buildEnvironment = { ...cloudflareEnvironment };
  delete buildEnvironment.CLOUDFLARE_API_TOKEN;
  run("pnpm", ["build"], {
    env: buildEnvironment,
    failureMessage: "Development topology monorepo build failed",
  });
  const outputs = selectDevelopmentTopologyOutputs(rendered.outputs, options.onlyKinds);
  const workers = [];
  for (const output of outputs) {
    const deploy = (secretFile) => {
      const args = [
        "exec",
        "wrangler",
        "deploy",
        "--config",
        resolve(root, output.path),
        "--strict",
        "--message",
        `Skillplane development topology ${commit.slice(0, 12)}`,
      ];
      if (secretFile) args.push("--secrets-file", secretFile);
      run("pnpm", args, {
        cwd: resolve(root, output.directory),
        env: cloudflareEnvironment,
        failureMessage: `${output.id} development deployment failed`,
      });
    };
    const secrets = topologySecrets(output);
    if (secrets) await withSecretFile(secrets, deploy);
    else deploy();
    workers.push({ id: output.id, name: output.config.name });
  }
  return {
    ok: true,
    environment: "development",
    commit,
    hyperdrives,
    schema,
    ownership,
    buckets,
    workers,
  };
}
