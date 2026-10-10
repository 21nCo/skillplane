import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

const root = resolve(import.meta.dirname, "..", "..");

export function parseArguments(arguments_) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument ?? ""}`);
    }
    const name = argument.slice(2);
    const next = arguments_[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return {
    value(name) {
      return values.get(name);
    },
    has(name) {
      return flags.has(name);
    },
  };
}

export async function resolveLocalDatabaseUrl(explicit) {
  if (explicit) return requirePostgresUrl(explicit);
  const configured = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (configured) return requirePostgresUrl(configured);
  const runtime = JSON.parse(
    await readFile(resolve(root, ".data", "local-runtime.json"), "utf8"),
  );
  return requirePostgresUrl(runtime.databaseUrl);
}

function requirePostgresUrl(value) {
  if (typeof value !== "string") {
    throw new Error("A Postgres database URL is required");
  }
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.pathname.slice(1)
  ) {
    throw new Error("The database URL is not a complete Postgres URL");
  }
  return value;
}

export function localDatabaseIdentity(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const username = decodeURIComponent(parsed.username);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
    !/^[A-Za-z0-9_]+$/u.test(database) ||
    !/^[A-Za-z0-9_]+$/u.test(username)
  ) {
    throw new Error(
      "Local recovery operations require a loopback host and simple database/user names",
    );
  }
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database,
    username,
  };
}

export function assertDisposableLocalDatabase(databaseUrl) {
  const identity = localDatabaseIdentity(databaseUrl);
  if (!identity.database.endsWith("_test")) {
    throw new Error(
      `Refusing destructive recovery operation for database "${identity.database}"`,
    );
  }
  return identity;
}

export async function recreateDisposableDatabase(databaseUrl) {
  const identity = assertDisposableLocalDatabase(databaseUrl);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({
    connectionString: adminUrl.toString(),
    application_name: "skillplane-local-recovery-admin",
    max: 1,
  });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [identity.database],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${identity.database}"`);
    await admin.query(`CREATE DATABASE "${identity.database}" TEMPLATE template0`);
  } finally {
    await admin.end();
  }
}

export async function dropDisposableDatabase(databaseUrl) {
  const identity = assertDisposableLocalDatabase(databaseUrl);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({
    connectionString: adminUrl.toString(),
    application_name: "skillplane-local-recovery-cleanup",
    max: 1,
  });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [identity.database],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${identity.database}"`);
  } finally {
    await admin.end();
  }
}

export async function databaseInventory(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "skillplane-backup-inventory",
    max: 1,
  });
  try {
    const [migrationResult, referenceResult] = await Promise.all([
      pool.query(
        `SELECT id, sha256
           FROM skillplane_schema_migrations
          ORDER BY id`,
      ),
      pool.query(
        `SELECT id AS version_id, workspace_id, skill_id, content_digest,
                r2_object_key, bundle_byte_size::text
           FROM skill_versions
          ORDER BY workspace_id, skill_id, revision, id`,
      ),
    ]);
    const migrations = migrationResult.rows;
    const bundleReferences = referenceResult.rows.map((row) => ({
      versionId: row.version_id,
      workspaceId: row.workspace_id,
      skillId: row.skill_id,
      digest: row.content_digest,
      objectKey: row.r2_object_key,
      byteSize: row.bundle_byte_size,
    }));
    return {
      migrations,
      bundleReferences,
      bundleReferenceDigest: sha256(
        Buffer.from(JSON.stringify(bundleReferences), "utf8"),
      ),
    };
  } finally {
    await pool.end();
  }
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function requireContainerName(value) {
  const name =
    value ?? process.env.SKILLPLANE_POSTGRES_CONTAINER ?? "skillplane-postgres";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
    throw new Error("The Postgres container name is invalid");
  }
  return name;
}

export { root };
