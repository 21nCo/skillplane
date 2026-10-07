import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";
import { gitSourceSchema } from "../../src/schema/git-sources.js";

// Schema-diff tooling trusts the Drizzle model, so every check and secondary
// index the migration creates must be modeled with the same order and predicate.
// UNIQUE(workspace_id,id) constraints follow the repository-wide uniqueIndex
// naming convention and are outside this comparison.
let pool: Pool;
beforeAll(async () => {
  const url = await resolveTestDatabaseUrl();
  await migrateDatabase(url);
  pool = new Pool({ connectionString: url, max: 1 });
}, 60000);
afterAll(() => pool.end());

it.each(Object.entries(gitSourceSchema))(
  "models every migrated check and index of %s",
  async (name, table: PgTable) => {
    const config = getTableConfig(table);
    const checks = await pool.query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'",
      [name],
    );
    expect(config.checks.map((c) => c.name).sort()).toEqual(
      checks.rows.map((r) => r.conname).sort(),
    );
    const indexes = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT i.indexname,i.indexdef FROM pg_indexes i
       WHERE i.tablename=$1 AND NOT EXISTS (
         SELECT 1 FROM pg_constraint c WHERE c.conindid=(quote_ident(i.indexname))::regclass
           AND c.contype IN ('p','u'))`,
      [name],
    );
    const modeled = config.indexes.map((i) => ({
      name: i.config.name,
      desc: i.config.columns.some(
        (c) => "indexConfig" in c && c.indexConfig?.order === "desc",
      ),
      partial: Boolean(i.config.where),
    }));
    for (const r of indexes.rows)
      expect(modeled).toContainEqual({
        name: r.indexname,
        desc: r.indexdef.includes(" DESC"),
        partial: r.indexdef.includes(" WHERE "),
      });
  },
);
