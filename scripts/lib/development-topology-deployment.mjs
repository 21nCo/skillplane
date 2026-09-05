import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  GLOBAL_CONTROL_TABLES,
  REGIONAL_WORKSPACE_TABLES,
} from "../../packages/control-plane/dist/table-ownership.js";
import { renderDevelopmentTopologyConfigs } from "../render-development-topology-config.mjs";
import {
  developmentCloudflareEnvironment,
  developmentDatabase,
  developmentPostHogProjectToken,
  developmentSecrets,
  ensurePrivateDevelopmentBucket,
  verifyDevelopmentHyperdrive,
} from "./development-deployment.mjs";
import {
  capture,
  captureWrangler,
  parseDirectPostgresUrl,
  requireEnvironment,
  requireSecretEnvironment,
  root,
  run,
  writeJsonAtomic,
} from "./production-deployment.mjs";

const databaseVariables = Object.freeze({
  "in-south": "SKILLPLANE_DEV_DATABASE_URL",
  "us-east": "SKILLPLANE_DEV_USEAST_DATABASE_URL",
  "eu-west": "SKILLPLANE_DEV_EUWEST_DATABASE_URL",
});

function assertNotProductionDatabase(database, name) {
  for (const productionVariable of [
    "SKILLPLANE_PRODUCTION_DATABASE_URL",
    "SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL",
    "RAILWAY_DATABASE_URL",
  ]) {
    const productionUrl = process.env[productionVariable]?.trim();
    if (
      productionUrl &&
      database.fingerprint === parseDirectPostgresUrl(productionUrl).fingerprint
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
      regionId === "in-south"
        ? developmentDatabase()
        : assertNotProductionDatabase(
            parseDirectPostgresUrl(requireEnvironment(variable), variable),
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

function topologySecrets(output) {
  if (output.kind === "projection") return null;
  const development = developmentSecrets();
  const shared = {
    OAUTH_TOKEN_PEPPER: development.OAUTH_TOKEN_PEPPER,
    WORKSPACE_ROUTING_KEYS: JSON.stringify({
      current: requireSecretEnvironment("SKILLPLANE_DEV_WORKSPACE_ROUTING_SECRET"),
    }),
  };
  if (output.id === "gateway:app") {
    return {
      AUTHFN_SECRET: development.AUTHFN_SECRET,
      TURNSTILE_SECRET_KEY: development.TURNSTILE_SECRET_KEY,
      ...shared,
    };
  }
  if (output.id === "gateway:mcp") {
    return {
      ...shared,
      POSTHOG_PROJECT_TOKEN: developmentPostHogProjectToken(),
    };
  }
  return shared;
}

export async function deployDevelopmentTopology() {
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
  const ownership = await verifyDevelopmentTopologyDatabaseOwnership(databases);
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
  const outputs = [...rendered.outputs].sort(
    (left, right) =>
      Number(left.id.startsWith("gateway:")) - Number(right.id.startsWith("gateway:")),
  );
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
    ownership,
    buckets,
    workers,
  };
}
