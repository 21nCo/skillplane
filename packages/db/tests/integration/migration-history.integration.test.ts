import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import {
  loadMigrations,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "../../src/index.js";

it("upgrades the originally applied 0043 without changing its ledger or accepting unknown hashes", async () => {
  const name = `history_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}_test`;
  const address = new URL(await resolveTestDatabaseUrl());
  address.pathname = "/postgres";
  const admin = new Pool({ connectionString: address.toString() });
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  address.pathname = `/${name}`;
  const database = new Pool({ connectionString: address.toString(), max: 1 });
  const original = await readFile(
    new URL("../fixtures/0043-original.sql", import.meta.url),
    "utf8",
  );
  const originalHash = createHash("sha256").update(original).digest("hex");
  const id = "0043_control_placement_region_integrity_followup.sql";
  try {
    await database.query(`CREATE TABLE skillplane_schema_migrations (
      id text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL CHECK (execution_ms >= 0))`);
    await database.query(
      "SELECT set_config('skillplane.initial_workspace_region', 'legacy', false)",
    );
    for (const migration of await loadMigrations()) {
      await database.query(migration.id === id ? original : migration.sql);
      await database.query(
        "INSERT INTO skillplane_schema_migrations (id, sha256, execution_ms) VALUES ($1, $2, 0)",
        [migration.id, migration.id === id ? originalHash : migration.sha256],
      );
    }
    await database.query(
      "INSERT INTO workspaces (id, workspace_id, slug, name) VALUES ('history', 'history', 'history', 'History')",
    );
    await expect(migrateDatabase(address.toString())).resolves.toMatchObject({
      applied: [],
    });
    expect(
      (
        await database.query(
          "SELECT sha256 FROM skillplane_schema_migrations WHERE id = $1",
          [id],
        )
      ).rows[0].sha256,
    ).toBe(originalHash);
    expect(
      (
        await database.query(`SELECT conname FROM pg_constraint
      WHERE conrelid = 'workspace_placements'::regclass AND contype = 'f' AND NOT convalidated`)
      ).rows,
    ).toEqual([]);
    await database.query(
      "UPDATE skillplane_schema_migrations SET sha256 = $2 WHERE id = $1",
      [id, "0".repeat(64)],
    );
    await expect(migrateDatabase(address.toString())).rejects.toThrow(
      "no longer matches its recorded hash",
    );
  } finally {
    await database.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 90_000);
