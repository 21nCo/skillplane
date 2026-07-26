import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertDisposableDatabaseUrl,
  projectRoot,
  resolveMigrationDatabaseUrl,
  verifyDatabase,
} from "@skillplane/db";
import { Pool } from "pg";

const sourceUrl = await resolveMigrationDatabaseUrl();
const source = new URL(sourceUrl);
if (!["127.0.0.1", "localhost", "::1"].includes(source.hostname)) {
  throw new Error("Backup verification is restricted to the local Postgres runtime");
}
const restoreDatabase = "skillplane_restore_test";
const restoreUrl = new URL(sourceUrl);
restoreUrl.pathname = `/${restoreDatabase}`;
assertDisposableDatabaseUrl(restoreUrl.toString());

const dump = execFileSync(
  "docker",
  [
    "exec",
    "skillplane-postgres",
    "pg_dump",
    "--username",
    decodeURIComponent(source.username),
    "--dbname",
    source.pathname.slice(1),
    "--format=custom",
    "--no-owner",
    "--no-privileges",
  ],
  { maxBuffer: 64 * 1024 * 1024 },
);
if (dump.byteLength === 0) {
  throw new Error("pg_dump produced an empty backup");
}

const backupDirectory = resolve(projectRoot, ".data", "backups");
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const backupPath = resolve(backupDirectory, "skillplane-verification.dump");
await writeFile(backupPath, dump, { mode: 0o600 });

const adminUrl = new URL(sourceUrl);
adminUrl.pathname = "/postgres";
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
try {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [restoreDatabase],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${restoreDatabase}"`);
  await admin.query(`CREATE DATABASE "${restoreDatabase}" TEMPLATE template0`);

  execFileSync(
    "docker",
    [
      "exec",
      "--interactive",
      "skillplane-postgres",
      "pg_restore",
      "--username",
      decodeURIComponent(source.username),
      "--dbname",
      restoreDatabase,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
    ],
    { input: dump, maxBuffer: 64 * 1024 * 1024 },
  );
  const verification = await verifyDatabase(restoreUrl.toString());
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        backupPath,
        backupBytes: dump.byteLength,
        restoredDatabase: restoreDatabase,
        migrations: verification.migrations,
        tables: verification.tables.length,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await admin.query(
    `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [restoreDatabase],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${restoreDatabase}"`);
  await admin.end();
}
