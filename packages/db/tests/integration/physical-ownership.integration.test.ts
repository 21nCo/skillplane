import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";

describe("dynamic DataFn physical ownership", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const controlDatabase = `skillplane_datafn_control_${suffix}_test`;
  const regionalDatabase = `skillplane_datafn_regional_${suffix}_test`;
  let admin: Pool | null = null;
  let controlUrl = "";
  let regionalUrl = "";

  beforeAll(async () => {
    const testUrl = await resolveTestDatabaseUrl();
    const adminAddress = new URL(testUrl);
    adminAddress.pathname = "/postgres";
    admin = new Pool({ connectionString: adminAddress.toString(), max: 1 });
    for (const database of [controlDatabase, regionalDatabase]) {
      await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    }
    const controlAddress = new URL(testUrl);
    controlAddress.pathname = `/${controlDatabase}`;
    controlUrl = controlAddress.toString();
    const regionalAddress = new URL(testUrl);
    regionalAddress.pathname = `/${regionalDatabase}`;
    regionalUrl = regionalAddress.toString();

    await migrateDatabase(controlUrl, {
      role: "control",
      initialWorkspaceRegion: "in-south",
      finalizePhysicalOwnership: false,
    });
    await migrateDatabase(regionalUrl, {
      role: "regional",
      finalizePhysicalOwnership: false,
    });
    for (const databaseUrl of [controlUrl, regionalUrl]) {
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      try {
        await pool.query(
          `CREATE TABLE datafn_runtime_records (
             __ns text NOT NULL,
             id text NOT NULL,
             PRIMARY KEY (__ns, id)
           )`,
        );
      } finally {
        await pool.end();
      }
    }
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    for (const database of [controlDatabase, regionalDatabase]) {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    }
    await admin.end();
  }, 30_000);

  it("removes dynamic tables from control and retains them in the regional cell", async () => {
    await migrateDatabase(controlUrl, {
      role: "control",
      initialWorkspaceRegion: "in-south",
    });
    await migrateDatabase(regionalUrl, { role: "regional" });

    const control = new Pool({ connectionString: controlUrl, max: 1 });
    const regional = new Pool({ connectionString: regionalUrl, max: 1 });
    try {
      const [controlTable, regionalTable] = await Promise.all([
        control.query<{ table_name: string | null }>(
          "SELECT to_regclass('public.datafn_runtime_records')::text AS table_name",
        ),
        regional.query<{ table_name: string | null }>(
          "SELECT to_regclass('public.datafn_runtime_records')::text AS table_name",
        ),
      ]);
      expect(controlTable.rows[0]?.table_name).toBeNull();
      expect(regionalTable.rows[0]?.table_name).toBe("datafn_runtime_records");
    } finally {
      await Promise.all([control.end(), regional.end()]);
    }
  });
});
