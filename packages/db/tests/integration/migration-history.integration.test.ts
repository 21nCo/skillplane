import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { expect, it } from "vitest";
import {
  loadMigrations,
  migrateDatabase,
  resolveTestDatabaseUrl,
  verifyDatabase,
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
    await database.query(
      "INSERT INTO workspace_placements (workspace_id, region_id, epoch, state) VALUES ('history', 'legacy', 1, 'active')",
    );
    // Reproduce an upgrade where 0040 arrived after 0043 was already applied.
    await database.query(
      "DELETE FROM skillplane_schema_migrations WHERE id IN ('0040_control_plane_safety_followup.sql', '0045_control_upgrade_fence_reconciliation.sql')",
    );
    await expect(migrateDatabase(address.toString())).resolves.toMatchObject({
      applied: [
        "0040_control_plane_safety_followup.sql",
        "0045_control_upgrade_fence_reconciliation.sql",
      ],
    });
    // An admitted legacy write must hold both transition rows until commit.
    await database.query(
      "UPDATE topology_cutover_state SET state = 'copying', target_region_id = 'legacy' WHERE id = 'legacy-to-cells'",
    );
    const writer = await database.connect();
    const transition = new Pool({ connectionString: address.toString(), max: 1 });
    try {
      await writer.query("BEGIN");
      await writer.query(
        "INSERT INTO skills (id, workspace_id, slug, name) VALUES ('history-skill', 'history', 'history-skill', 'History skill')",
      );
      await transition.query("SET lock_timeout = '200ms'");
      await expect(
        transition.query(
          "UPDATE topology_cutover_state SET state = 'complete' WHERE id = 'legacy-to-cells'",
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await transition.query("SET lock_timeout = '200ms'");
      await expect(
        transition.query(
          "UPDATE workspace_placements SET epoch = epoch + 1 WHERE workspace_id = 'history'",
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      await writer.query("COMMIT");
    } finally {
      await writer.query("ROLLBACK");
      writer.release();
      await transition.end();
    }
    await expect(
      database.query(
        "UPDATE workspace_placements SET moving_to_region_id = 'legacy', state = 'moving' WHERE workspace_id = 'history'",
      ),
    ).resolves.toBeDefined();
    await database.query(
      "INSERT INTO workspace_regions (region_id, enabled) VALUES ('disabled', false)",
    );
    await expect(
      database.query(
        "UPDATE workspace_placements SET moving_to_region_id = 'disabled' WHERE workspace_id = 'history'",
      ),
    ).rejects.toThrow("declared enabled current and moving regions");

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
    await expect(verifyDatabase(address.toString())).resolves.toBeDefined();
    await database.query(
      "UPDATE skillplane_schema_migrations SET sha256 = $2 WHERE id = $1",
      [id, "0".repeat(64)],
    );
    await expect(migrateDatabase(address.toString())).rejects.toThrow(
      "no longer matches its recorded hash",
    );
    await expect(verifyDatabase(address.toString())).rejects.toThrow(
      "Migration ledger mismatch",
    );
  } finally {
    await database.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 90_000);
