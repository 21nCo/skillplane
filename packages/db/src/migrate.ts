import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { packageRoot } from "./database-url.js";

import { resolve } from "node:path";

const migrationsDirectory = resolve(packageRoot, "migrations");
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;

export interface Migration {
  readonly id: string;
  readonly sha256: string;
  readonly sql: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export async function loadMigrations(
  directory = migrationsDirectory,
): Promise<readonly Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => migrationPattern.test(name))
    .sort();
  if (names.length === 0) {
    throw new Error(`No migrations found in ${directory}`);
  }
  return Promise.all(
    names.map(async (id) => {
      const sql = await readFile(resolve(directory, id), "utf8");
      return {
        id,
        sha256: createHash("sha256").update(sql).digest("hex"),
        sql,
      };
    }),
  );
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS skillplane_schema_migrations (
      id text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL CHECK (execution_ms >= 0)
    )
  `);
}

export async function migrateDatabase(databaseUrl: string): Promise<MigrationResult> {
  const migrations = await loadMigrations();
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "skillplane-migrator",
    max: 1,
  });
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      "skillplane-schema-migrations-v1",
    ]);
    await ensureLedger(client);
    const ledger = await client.query<{ id: string; sha256: string }>(
      "SELECT id, sha256 FROM skillplane_schema_migrations ORDER BY id",
    );
    const known = new Map(ledger.rows.map((row) => [row.id, row.sha256]));

    for (const migration of migrations) {
      const previousHash = known.get(migration.id);
      if (previousHash !== undefined) {
        if (previousHash !== migration.sha256) {
          throw new Error(
            `Applied migration ${migration.id} no longer matches its recorded hash`,
          );
        }
        alreadyApplied.push(migration.id);
        continue;
      }
      const startedAt = performance.now();
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO skillplane_schema_migrations
             (id, sha256, execution_ms)
           VALUES ($1, $2, $3)`,
          [
            migration.id,
            migration.sha256,
            Math.max(0, Math.round(performance.now() - startedAt)),
          ],
        );
        await client.query("COMMIT");
        applied.push(migration.id);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return { applied, alreadyApplied };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [
        "skillplane-schema-migrations-v1",
      ])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}
