import { getTableConfig, PgDialect, type PgTable } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";
import { gitSourceSchema } from "../../src/schema/git-sources.js";

// Schema-diff tooling trusts the Drizzle model, so every check and secondary
// index the migration creates must be modeled with the same definition. Postgres
// canonicalizes both sides: the modeled definitions are created on a temporary
// probe table and compared with the migrated table's catalog definitions.
// UNIQUE(workspace_id,id) constraints follow the repository-wide uniqueIndex
// naming convention and are outside this comparison.
let pool: Pool;
const dialect = new PgDialect();
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
    const render = (value: SQL) =>
      dialect.sqlToQuery(value).sql.replaceAll(`"${name}".`, "");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TEMP TABLE git_schema_probe (LIKE ${name})`);
      for (const c of config.checks)
        await client.query(
          `ALTER TABLE git_schema_probe ADD CONSTRAINT "${c.name}" CHECK (${render(c.value)})`,
        );
      const checks = async (relation: string) =>
        Object.fromEntries(
          (
            await client.query<{ conname: string; def: string }>(
              "SELECT conname,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'",
              [relation],
            )
          ).rows.map((r) => [r.conname, r.def]),
        );
      expect(await checks("git_schema_probe")).toEqual(await checks(name));

      const migrated = await client.query<{ name: string; def: string }>(
        `SELECT c.relname AS name,pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
         WHERE i.indrelid=$1::regclass AND NOT EXISTS (
           SELECT 1 FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u'))`,
        [name],
      );
      // Compare everything after the index and relation names: uniqueness,
      // method, ordered keys with direction, and the partial predicate.
      const shape = (def: string) =>
        `${def.startsWith("CREATE UNIQUE") ? "UNIQUE " : ""}${def.slice(def.indexOf(" USING "))}`;
      for (const index of migrated.rows) {
        const modeled = config.indexes.find((i) => i.config.name === index.name);
        expect(modeled, `${index.name} is modeled`).toBeDefined();
        if (!modeled) continue;
        const keys = modeled.config.columns.map((column) => {
          if (!("name" in column) || !("indexConfig" in column))
            throw new Error(`${index.name} models an expression key`);
          return `"${column.name}"${column.indexConfig.order === "desc" ? " DESC" : ""}`;
        });
        const probe = `${index.name}_probe`;
        await client.query(
          `CREATE ${modeled.config.unique ? "UNIQUE " : ""}INDEX "${probe}" ON git_schema_probe (${keys.join(",")})${
            modeled.config.where ? ` WHERE ${render(modeled.config.where)}` : ""
          }`,
        );
        const created = await client.query<{ def: string }>(
          "SELECT pg_get_indexdef($1::regclass) AS def",
          [probe],
        );
        expect(shape(created.rows[0]?.def ?? "")).toBe(shape(index.def));
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  },
);
