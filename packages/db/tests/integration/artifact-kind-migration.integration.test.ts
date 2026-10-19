import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
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

/**
 * Splits a script into top-level statements the way psql does, keeping
 * comments, quoted strings and dollar-quoted bodies intact.
 */
function statements(script: string): string[] {
  const result: string[] = [];
  let start = 0;
  let index = 0;
  while (index < script.length) {
    const rest = script.slice(index);
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (rest.startsWith("--")) {
      const end = script.indexOf("\n", index);
      index = end < 0 ? script.length : end + 1;
    } else if (rest.startsWith("'")) {
      index = script.indexOf("'", index + 1) + 1;
    } else if (dollar) {
      const end = script.indexOf(dollar[0], index + dollar[0].length);
      index = end + dollar[0].length;
    } else if (rest.startsWith(";")) {
      result.push(script.slice(start, index + 1).trim());
      start = index += 1;
    } else index += 1;
  }
  if (script.slice(start).replace(/--.*$/gm, "").trim()) {
    result.push(script.slice(start).trim());
  }
  return result;
}

/**
 * Runs each statement separately and keeps going after an error, as psql -f
 * does without ON_ERROR_STOP. Returns the error messages in order.
 */
async function runLikePsql(
  client: PoolClient,
  script: string,
  afterStatement?: (statement: string) => Promise<void>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const statement of statements(script)) {
    await client.query(statement).catch((error: Error) => errors.push(error.message));
    await afterStatement?.(statement);
  }
  return errors;
}

let auditSequence = 0;

/** Records one successful retrieval and returns the workspace agent-use counter. */
async function countRetrieval(pool: Pool, countMetric?: false): Promise<string> {
  auditSequence += 1;
  await pool.query(
    `INSERT INTO audit_events
       (id, workspace_id, event_type, action, outcome, actor_type, actor_id,
        request_id, metadata)
     VALUES ($1, 'kind-workspace', 'mcp.skill_retrieve.success', 'skill_retrieve',
             'success', 'user', 'kind-user', $1, $2::jsonb)`,
    [
      `kind-audit-${auditSequence}`,
      JSON.stringify(countMetric === false ? { countMetric } : {}),
    ],
  );
  const counter = await pool.query<{ agent_skill_uses: string }>(
    `SELECT agent_skill_uses::text FROM public_stats_counters
      WHERE id = 'kind-workspace'`,
  );
  return counter.rows[0]?.agent_skill_uses ?? "0";
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

        // Instructions retrievals never count as public agent skill uses.
        expect(await countRetrieval(pool)).toBe("1");
        expect(await countRetrieval(pool, false)).toBe("1");

        const rollback = await readFile(
          resolve(packageRoot, "migrations/rollback", MIGRATION),
          "utf8",
        );
        await pool.query(
          `INSERT INTO skills (id, workspace_id, slug, name, kind)
         VALUES ('kind-agents', 'kind-workspace', 'agents', 'Agents', 'instructions')`,
        );
        const ledgerRows = async () =>
          (
            await pool.query(
              "SELECT 1 FROM skillplane_schema_migrations WHERE id = $1",
              [MIGRATION],
            )
          ).rowCount;
        const refusedIntact = async () => {
          expect(await kindColumn(pool)).toBeDefined();
          expect(
            (await pool.query("SELECT kind FROM skills WHERE id = 'kind-agents'")).rows,
          ).toEqual([{ kind: "instructions" }]);
          expect(await ledgerRows()).toBe(1);
        };

        // A single-query runner refuses atomically.
        const runner = await pool.connect();
        try {
          await expect(runner.query(rollback)).rejects.toThrow(
            "instructions artifacts exist",
          );
          await runner.query("ROLLBACK");
        } finally {
          runner.release();
        }
        await refusedIntact();

        // psql -f without ON_ERROR_STOP runs on after the guard raises; the
        // transaction turns every later statement and COMMIT into a no-op.
        // The lock is held before the guard, so a concurrent instructions
        // insert cannot slip in between the check and the drop.
        const other = new Pool({ connectionString: urls[role], max: 1 });
        const psql = await other.connect();
        let concurrentInsert: unknown;
        try {
          const errors = await runLikePsql(psql, rollback, async (statement) => {
            if (!statement.startsWith("LOCK TABLE skills")) return;
            concurrentInsert = await pool
              .query(
                `SET lock_timeout = '200ms';
                 INSERT INTO skills (id, workspace_id, slug, name, kind)
                 VALUES ('kind-race', 'kind-workspace', 'race', 'Race', 'instructions')`,
              )
              .catch((error: { code?: string }) => error.code);
            await pool.query("RESET lock_timeout");
          });
          expect(errors[0]).toContain("instructions artifacts exist");
          expect(errors.length).toBeGreaterThan(1);
          expect(
            errors
              .slice(1)
              .every((message) => message.includes("current transaction is aborted")),
          ).toBe(true);
          expect(
            (await psql.query<{ state: string }>("SELECT 'idle' AS state")).rows,
          ).toEqual([{ state: "idle" }]);
        } finally {
          psql.release();
          await other.end();
        }
        expect(concurrentInsert).toBe("55P03");
        expect(
          (await pool.query("SELECT 1 FROM skills WHERE id = 'kind-race'")).rowCount,
        ).toBe(0);
        await refusedIntact();
        await pool.query("DELETE FROM skills WHERE id = 'kind-agents'");

        // Behind a long transaction the rollback gives up at LOCK instead of
        // queueing every later skills reader. The test-side statement_timeout
        // only bounds a regression; the rollback's own lock_timeout is shorter.
        const blockers = new Pool({ connectionString: urls[role], max: 2 });
        const blocker = await blockers.connect();
        const waiting = await blockers.connect();
        let readerAfterRefusal: unknown;
        try {
          await blocker.query("BEGIN");
          await blocker.query("SELECT 1 FROM skills LIMIT 1");
          await waiting.query("SET statement_timeout = '15s'");
          const started = Date.now();
          const errors = await runLikePsql(waiting, rollback, async (statement) => {
            if (!statement.startsWith("LOCK TABLE skills")) return;
            await pool.query("SET statement_timeout = '1s'");
            readerAfterRefusal = await pool
              .query("SELECT kind FROM skills WHERE id = 'kind-skill'")
              .then((result) => result.rows)
              .catch((error: { code?: string }) => error.code);
            await pool.query("RESET statement_timeout");
          });
          expect(errors[0]).toContain("lock timeout");
          expect(Date.now() - started).toBeLessThan(15_000);
          expect(
            errors
              .slice(1)
              .every((message) => message.includes("current transaction is aborted")),
          ).toBe(true);
        } finally {
          await blocker.query("COMMIT").catch(() => undefined);
          blocker.release();
          waiting.release();
          await blockers.end();
        }
        expect(readerAfterRefusal).toEqual([{ kind: "skill" }]);
        expect(await kindColumn(pool)).toBeDefined();
        expect(await ledgerRows()).toBe(1);

        const success = await pool.connect();
        try {
          expect(await runLikePsql(success, rollback)).toEqual([]);
        } finally {
          success.release();
        }
        expect(await kindColumn(pool)).toBeUndefined();
        // Rollback restores the 0019 trigger, which counts every retrieval.
        expect(await countRetrieval(pool, false)).toBe("2");
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
        expect(await countRetrieval(pool, false)).toBe("2");
        expect(await countRetrieval(pool)).toBe("3");
        // Regional verification requires finalized physical ownership, which
        // this per-migration test deliberately skips (see physical-ownership tests).
        if (role === "combined")
          await expect(verifyDatabase(urls[role])).resolves.toBeDefined();
      } finally {
        await pool.end();
      }
    }, 60_000);
  },
);
