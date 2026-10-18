import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  migrateDatabase,
  resolveTestDatabaseUrl,
  verifyDatabase,
} from "../../src/index.js";
import { packageRoot } from "../../src/database-url.js";

const MIGRATION = "0054_regional_artifact_kind.sql";
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const databases = {
  combined: `skillplane_kind_combined_${suffix}_test`,
  regional: `skillplane_kind_regional_${suffix}_test`,
} as const;
let admin: Pool;
const urls: Record<keyof typeof databases, string> = { combined: "", regional: "" };

async function kindColumn(pool: Pool) {
  return (
    await pool.query<{ column_default: string; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'skills' AND column_name = 'kind'`,
    )
  ).rows[0];
}

beforeAll(async () => {
  const testUrl = new URL(await resolveTestDatabaseUrl());
  testUrl.pathname = "/postgres";
  admin = new Pool({ connectionString: testUrl.toString(), max: 1 });
  for (const role of ["combined", "regional"] as const) {
    await admin.query(`CREATE DATABASE "${databases[role]}" TEMPLATE template0`);
    testUrl.pathname = `/${databases[role]}`;
    urls[role] = testUrl.toString();
  }
  await migrateDatabase(urls.combined);
  await migrateDatabase(urls.regional, {
    role: "regional",
    finalizePhysicalOwnership: false,
  });
}, 120_000);

afterAll(async () => {
  for (const database of Object.values(databases)) {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  }
  await admin.end();
});

describe.each(["combined", "regional"] as const)(
  "%s artifact kind migration",
  (role) => {
    it("defaults existing skills, guards instructions visibility, and rolls back cleanly", async () => {
      const pool = new Pool({ connectionString: urls[role], max: 1 });
      try {
        await pool.query(
          `INSERT INTO skills (id, workspace_id, slug, name, visibility)
         VALUES ('kind-skill', 'kind-workspace', 'existing', 'Existing', 'public')`,
        );
        expect(await kindColumn(pool)).toEqual({
          column_default: "'skill'::text",
          is_nullable: "NO",
        });
        expect(
          (await pool.query("SELECT kind FROM skills WHERE id = 'kind-skill'")).rows,
        ).toEqual([{ kind: "skill" }]);
        await expect(
          pool.query(
            `INSERT INTO skills (id, workspace_id, slug, name, visibility, kind)
           VALUES ('kind-public', 'kind-workspace', 'public-agents', 'Agents', 'public', 'instructions')`,
          ),
        ).rejects.toMatchObject({ constraint: "skills_instructions_visibility" });
        await expect(
          pool.query(
            `INSERT INTO skills (id, workspace_id, slug, name, kind)
           VALUES ('kind-bad', 'kind-workspace', 'bad', 'Bad', 'agent')`,
          ),
        ).rejects.toMatchObject({ constraint: "skills_kind" });

        const rollback = await readFile(
          resolve(packageRoot, "migrations/rollback", MIGRATION),
          "utf8",
        );
        await pool.query(
          `INSERT INTO skills (id, workspace_id, slug, name, kind)
         VALUES ('kind-agents', 'kind-workspace', 'agents', 'Agents', 'instructions')`,
        );
        await expect(pool.query(rollback)).rejects.toThrow(
          "instructions artifacts exist",
        );
        expect(await kindColumn(pool)).toBeDefined();
        await pool.query("DELETE FROM skills WHERE id = 'kind-agents'");

        await pool.query(rollback);
        expect(await kindColumn(pool)).toBeUndefined();
        expect(
          (
            await pool.query(
              "SELECT 1 FROM skillplane_schema_migrations WHERE id = $1",
              [MIGRATION],
            )
          ).rowCount,
        ).toBe(0);

        // Reapplying through the runner restores the column and the ledger entry.
        const result = await migrateDatabase(
          urls[role],
          role === "regional"
            ? { role: "regional", finalizePhysicalOwnership: false }
            : {},
        );
        expect(result.applied).toEqual([MIGRATION]);
        expect(
          (await pool.query("SELECT kind FROM skills WHERE id = 'kind-skill'")).rows,
        ).toEqual([{ kind: "skill" }]);
        // Regional verification requires finalized physical ownership, which
        // this per-migration test deliberately skips (see physical-ownership tests).
        if (role === "combined")
          await expect(verifyDatabase(urls[role])).resolves.toBeDefined();
      } finally {
        await pool.end();
      }
    });
  },
);
