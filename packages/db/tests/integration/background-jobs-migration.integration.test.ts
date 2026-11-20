import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  migrateDatabase,
  resolveTestDatabaseUrl,
  verifyDatabase,
} from "../../src/index.js";

const MIGRATION = "0055_regional_background_jobs.sql";
const database = `skillplane_jobs_cell_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_test`;
let admin: Pool;
let url = "";

beforeAll(async () => {
  const testUrl = new URL(await resolveTestDatabaseUrl());
  testUrl.pathname = "/postgres";
  admin = new Pool({ connectionString: testUrl.toString(), max: 1 });
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  testUrl.pathname = `/${database}`;
  url = testUrl.toString();
  await migrateDatabase(url, { role: "regional" });
}, 120_000);

afterAll(async () => {
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
});

it("applies on a cell at 0054 and ownership verification requires the table", async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    // Rewind the cell to 0054, the state of every cell before this change.
    await pool.query(`BEGIN;
      DROP TABLE background_jobs;
      DELETE FROM skillplane_schema_migrations WHERE id = '${MIGRATION}';
      COMMIT;`);
    await expect(verifyDatabase(url, { role: "regional" })).rejects.toThrow(
      /Missing required tables: background_jobs/u,
    );

    const result = await migrateDatabase(url, { role: "regional" });
    expect(result.applied).toEqual([MIGRATION]);
    const verification = await verifyDatabase(url, { role: "regional" });
    expect(verification.tables).toContain("background_jobs");
    expect(verification.migrations).toContain(MIGRATION);

    // Writes are fenced while the workspace migrates to another cell.
    const triggers = await pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'background_jobs'::regclass AND NOT tgisinternal`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "background_jobs_migration_fence",
    ]);
    await pool.query(
      `INSERT INTO regional_workspace_migration_fences (workspace_id, source_epoch, active_epoch)
       VALUES ('fenced-workspace', 3, 1)`,
    );
    await expect(
      pool.query(
        `INSERT INTO background_jobs (id, workspace_id, kind, idempotency_key)
         VALUES ('fenced-job', 'fenced-workspace', 'test.echo', 'key')`,
      ),
    ).rejects.toMatchObject({ code: "55000" });

    // A job holds a lease exactly while it runs.
    await pool.query(
      `INSERT INTO background_jobs (id, workspace_id, kind, idempotency_key)
       VALUES ('job-a', 'jobs-workspace', 'test.echo', 'key')`,
    );
    await expect(
      pool.query("UPDATE background_jobs SET state = 'running' WHERE id = 'job-a'"),
    ).rejects.toMatchObject({ constraint: "background_jobs_lease_check" });
    await expect(
      pool.query(
        `UPDATE background_jobs SET lease_owner = 'w', lease_expires_at = now()
          WHERE id = 'job-a'`,
      ),
    ).rejects.toMatchObject({ constraint: "background_jobs_lease_check" });
    await expect(
      pool.query(
        `INSERT INTO background_jobs (id, workspace_id, kind, idempotency_key)
         VALUES ('job-b', 'jobs-workspace', 'test.echo', 'key')`,
      ),
    ).rejects.toMatchObject({ constraint: "background_jobs_idempotency_unique" });
    await expect(
      pool.query(
        `INSERT INTO background_jobs (id, workspace_id, kind, idempotency_key, payload)
         VALUES ('job-c', 'jobs-workspace', 'test.echo', 'other', '[]')`,
      ),
    ).rejects.toMatchObject({ constraint: "background_jobs_payload_check" });
    await expect(
      pool.query(
        `INSERT INTO background_jobs (id, workspace_id, kind, idempotency_key)
         VALUES ('job-d', 'jobs-workspace', 'echo', 'other')`,
      ),
    ).rejects.toMatchObject({ constraint: "background_jobs_kind_check" });
  } finally {
    await pool.end();
  }
});
