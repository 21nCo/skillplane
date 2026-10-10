import {
  assertDisposableDatabaseUrl,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "@skillplane/db";
import { Pool } from "pg";

/** Recreates only the explicitly named local test database, then migrates it. */
export async function resetTestDatabase(): Promise<string> {
  const databaseUrl = await resolveTestDatabaseUrl();
  assertDisposableDatabaseUrl(databaseUrl);
  const target = new URL(databaseUrl);
  const databaseName = target.pathname.slice(1);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const pool = new Pool({
    connectionString: adminUrl.toString(),
    application_name: "skillplane-test-reset",
    max: 1,
  });
  try {
    await pool.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await pool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  } finally {
    await pool.end();
  }
  await migrateDatabase(databaseUrl);
  return databaseUrl;
}
