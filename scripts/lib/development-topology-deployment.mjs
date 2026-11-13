import { topologySecrets } from "./development-topology-secrets.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import ConnectionParameters from "pg/lib/connection-parameters.js";
import {
  GLOBAL_CONTROL_TABLES,
  REGIONAL_WORKSPACE_TABLES,
} from "../../packages/control-plane/dist/table-ownership.js";
import { loadMigrations } from "../../packages/db/dist/src/migrate.js";
import { renderDevelopmentTopologyConfigs } from "../render-development-topology-config.mjs";
import {
  developmentDatabase,
  ensurePrivateDevelopmentBucket,
  verifiedDevelopmentCloudflareEnvironment,
  verifyDevelopmentHyperdrive,
} from "./development-deployment.mjs";
import {
  capture,
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

// Compares destinations as DNS does: case-insensitive, with or without the
// root label's trailing dot.
function destinationKey({ host, port, database }) {
  return JSON.stringify([
    String(host).toLowerCase().replace(/\.$/u, ""),
    String(port),
    database,
  ]);
}

const destinationQueryParameters = new Set(["host", "hostaddr", "port"]);
const canonicalHostPattern =
  /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/u;
const canonicalIpv4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u;

// One spelling per destination, shared by both sides of the production
// comparison: lowercase DNS labels or a bracketed IPv6 literal, and an IPv4
// address only as a dotted quad. A name whose last label is numeric or hex
// (2130706433, 127.1, 0x7f.1, 0177.0.0.1) is an alternative IPv4 spelling, so
// it could never equal the canonical spelling of the same address.
function isCanonicalHost(host) {
  if (typeof host !== "string" || !canonicalHostPattern.test(host)) return false;
  const lastLabel = host.split(".").at(-1);
  return !/^(?:\d+|0x[0-9a-f]*)$/u.test(lastLabel) || canonicalIpv4.test(host);
}

// A production target is compared after DNS normalization (case and the root
// label's trailing dot), but its host must otherwise be canonical.
function isCanonicalProductionHost(host) {
  return (
    typeof host === "string" && isCanonicalHost(host.toLowerCase().replace(/\.$/u, ""))
  );
}

// U+0000-U+001F or U+007F.
function hasControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

// The PostgreSQL startup packet is a list of NUL-terminated key and value
// strings, so a control character in any of them can split a value or add a
// key: an application_name of `x\0database\0prod` sends a second database that
// the server uses. Every component is checked on its own, as written and as
// the driver parses it, and one that cannot be decoded fails closed. Returns
// the reason a URL is refused, or null. The reason never contains the value,
// because it can be a password.
function controlCharacterRefusal(url) {
  let parsed;
  let parameters;
  try {
    parsed = new URL(url);
    parameters = new ConnectionParameters({ connectionString: url });
  } catch {
    return "a value the PostgreSQL driver cannot parse";
  }
  const encoded = [
    ["user", parsed.username],
    ["password", parsed.password],
    ["database", parsed.pathname.slice(1)],
  ];
  const decoded = [...parsed.searchParams].flatMap(([key, value]) => [
    ["query parameter name", key],
    ["query parameter value", value],
  ]);
  for (const [name, value] of encoded) {
    try {
      decoded.push([name, decodeURIComponent(value)]);
    } catch {
      return `an undecodable ${name}`;
    }
  }
  // `password` is not enumerable on ConnectionParameters.
  decoded.push(["password", parameters.password], ...Object.entries(parameters));
  const found = decoded.find(
    ([, value]) => typeof value === "string" && hasControlCharacter(value),
  );
  return found ? `a control character in its ${found[0]}` : null;
}

export const productionIdentitiesVariable = "SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES";

// Non-secret production database identities (`host[:port]/database`, separated
// by commas or whitespace) let an environment without production credentials,
// such as the development deploy job, still refuse a production database.
export function productionDatabaseIdentityKeys(environment = process.env) {
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
      const identityUrl = `postgresql://identity:identity@${identity}`;
      const refusal = controlCharacterRefusal(identityUrl);
      if (refusal) {
        throw new Error(
          `${productionIdentitiesVariable} entries must not contain ${refusal}`,
        );
      }
      const { identity: destination } = parseDirectPostgresUrl(
        identityUrl,
        productionIdentitiesVariable,
      );
      if (!isCanonicalProductionHost(destination.host)) {
        throw new Error(
          `${productionIdentitiesVariable} entries must name their host in canonical form: ${identity}`,
        );
      }
      return destinationKey(destination);
    });
}

// The production URL variables are only present where an operator happens to
// keep them (the development commands load only `.env.development.local`, and
// GitHub Actions has none), so comparing against them alone can compare against
// nothing. Every development migration therefore fails closed until the
// non-secret production identities are configured, on any host.
export function assertProductionIsolationConfigured(environment = process.env) {
  if (productionDatabaseIdentityKeys(environment).length === 0) {
    throw new Error(
      `PRODUCTION_ISOLATION_UNCONFIGURED: ${productionIdentitiesVariable} must list the production database identities`,
    );
  }
}

// The destination node-postgres will connect to for a URL. Its parser lets
// query `host` and `port` override the authority, decodes a percent-encoded
// host, and falls back to PGPORT for a URL without a port.
export function driverDestination(url) {
  const parameters = new ConnectionParameters({ connectionString: url });
  return {
    host: parameters.host,
    port: parameters.port,
    database: parameters.database,
  };
}

// The production comparison below is by URL authority, so a development URL
// must connect exactly where its authority says. Refuses, before any
// connection, a control character in any component (it can add a startup
// parameter, such as a second database), query parameters that move the
// connection, a percent-encoded or
// otherwise non-canonical host (a trailing dot, a numeric IPv4 form such as
// 2130706433 or 0x7f.1), and any remaining difference from the driver's parse.
export function assertDevelopmentDestination(database, name) {
  const url = new URL(database.url);
  const refuse = (reason) => {
    throw new Error(`DEVELOPMENT_DATABASE_DESTINATION_AMBIGUOUS: ${name} ${reason}`);
  };
  const refusal = controlCharacterRefusal(database.url);
  if (refusal) refuse(`must not contain ${refusal}`);
  for (const key of url.searchParams.keys()) {
    if (destinationQueryParameters.has(key.toLowerCase())) {
      refuse(`must not set the ${key} query parameter`);
    }
  }
  if (!isCanonicalHost(database.identity.host)) {
    refuse("must name its host in canonical form");
  }
  let destination;
  try {
    destination = driverDestination(database.url);
  } catch {
    refuse("is not a connection string the PostgreSQL driver accepts");
  }
  if (destinationKey(destination) !== destinationKey(database.identity)) {
    refuse("connects somewhere other than its URL host, port, and database");
  }
  return database;
}

function assertNotProductionDatabase(database, name) {
  assertDevelopmentDestination(database, name);
  const destination = destinationKey(database.identity);
  if (productionDatabaseIdentityKeys().includes(destination)) {
    throw new Error(`${name} must differ from ${productionIdentitiesVariable}`);
  }
  for (const productionVariable of productionDatabaseVariables()) {
    const productionUrl = process.env[productionVariable]?.trim();
    if (!productionUrl) continue;
    const production = parseDirectPostgresUrl(productionUrl, productionVariable);
    const refusal = controlCharacterRefusal(production.url);
    if (refusal) {
      throw new Error(
        `PRODUCTION_DATABASE_DESTINATION_AMBIGUOUS: ${productionVariable} must not contain ${refusal}`,
      );
    }
    // A production URL is compared both by its authority and by where the
    // driver would send it. Either side that cannot be reduced to a canonical
    // destination is refused rather than compared, because no accepted
    // development URL could ever equal it.
    let driverTarget;
    try {
      driverTarget = driverDestination(production.url);
    } catch {
      driverTarget = undefined;
    }
    if (
      !driverTarget ||
      !isCanonicalProductionHost(production.identity.host) ||
      !isCanonicalProductionHost(driverTarget.host)
    ) {
      throw new Error(
        `PRODUCTION_DATABASE_DESTINATION_AMBIGUOUS: ${productionVariable} must name its host in canonical form`,
      );
    }
    if (
      destination === destinationKey(production.identity) ||
      destination === destinationKey(driverTarget)
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
  const cloudflareEnvironment = await verifiedDevelopmentCloudflareEnvironment(options);
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
  const databases = developmentTopologyDatabases();
  const rendered = await renderDevelopmentTopologyConfigs();
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
