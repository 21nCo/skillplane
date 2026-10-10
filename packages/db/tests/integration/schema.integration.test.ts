import { beforeAll, describe, expect, it } from "vitest";
import {
  loadMigrations,
  migrateDatabase,
  resolveTestDatabaseUrl,
  verifyDatabase,
} from "../../src/index.js";
import { Pool } from "pg";

let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
});

describe("Postgres schema integrity", () => {
  it("is repeatably migratable and passes inventory/query-plan verification", async () => {
    const repeat = await migrateDatabase(databaseUrl);
    expect(repeat.applied).toEqual([]);
    expect(repeat.alreadyApplied).toHaveLength((await loadMigrations()).length);
    const verification = await verifyDatabase(databaseUrl);
    expect(verification.tables).toContain("skill_versions");
    expect(verification.queryPlans["skillRevision"]?.length).toBeGreaterThan(0);
  });

  it("rejects invalid tenant identities and agent amendments without attribution", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await expect(
        pool.query(
          `INSERT INTO workspaces (id, workspace_id, slug, name)
           VALUES ('workspace:invalid', 'workspace:other', 'invalid', 'Invalid')`,
        ),
      ).rejects.toMatchObject({ code: "23514" });

      await pool.query(
        `INSERT INTO authfn_users
           (id, primary_email, created_at, updated_at)
         VALUES ('user:db-integrity', 'db-integrity@example.test', now(), now())
         ON CONFLICT (id) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO workspaces (id, workspace_id, slug, name)
         VALUES (
           'workspace:db-integrity',
           'workspace:db-integrity',
           'db-integrity',
           'DB Integrity'
         )
         ON CONFLICT (id) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO skills (id, workspace_id, slug, name)
         VALUES (
           'skill:db-integrity',
           'workspace:db-integrity',
           'db-integrity',
           'DB Integrity'
         )
         ON CONFLICT (id) DO NOTHING`,
      );
      await expect(
        pool.query(
          `INSERT INTO skill_versions (
             id, workspace_id, skill_id, revision, status, source,
             content_digest, r2_object_key, bundle_byte_size, manifest,
             created_by_actor_type, created_by_actor_id
           ) VALUES (
             'version:invalid-attribution', 'workspace:db-integrity',
             'skill:db-integrity', 1, 'draft', 'agent_amendment',
             $1, $2, 100, '{}'::jsonb, 'service_principal', 'service:test'
           )`,
          [
            `sha256:${"a".repeat(64)}`,
            `workspaces/workspace_db/skills/skill_db/bundles/sha256/${"a".repeat(
              64,
            )}.zip`,
          ],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await pool.end();
    }
  });

  it("makes context revision records append-only", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await pool.query(
        `INSERT INTO skill_contexts
           (id, workspace_id, skill_id, slug, name)
         VALUES (
           'context:db-integrity', 'workspace:db-integrity',
           'skill:db-integrity', 'repository', 'Repository'
         )
         ON CONFLICT (id) DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO context_knowledge_revisions (
           id, workspace_id, context_id, revision, knowledge,
           body_digest, created_by_actor_type, created_by_actor_id
         ) VALUES (
           'knowledge:db-integrity', 'workspace:db-integrity',
           'context:db-integrity', 1, 'Never expose tenant data',
           $1, 'user', 'user:db-integrity'
         )
         ON CONFLICT (id) DO NOTHING`,
        [`sha256:${"c".repeat(64)}`],
      );
      await expect(
        pool.query(
          `UPDATE context_knowledge_revisions
              SET knowledge = 'mutated'
            WHERE id = 'knowledge:db-integrity'`,
        ),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await pool.end();
    }
  });

  it("allows publication once, validates release pointers, and freezes published rows", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO skill_versions (
           id, workspace_id, skill_id, revision, status, source,
           content_digest, r2_object_key, bundle_byte_size, manifest,
           learning_metadata,
           created_by_actor_type, created_by_actor_id, created_by_agent,
           created_by_model, created_for_user_id
         ) VALUES (
           'version:db-integrity-valid', 'workspace:db-integrity',
           'skill:db-integrity', 1, 'draft', 'agent_amendment',
           $1, $2, 100, '{}'::jsonb, '{"confidence": 0.9}'::jsonb,
           'service_principal', 'service:test', 'codex', 'gpt-test',
           'user:db-integrity'
         )`,
        [
          `sha256:${"b".repeat(64)}`,
          `workspaces/workspace_db/skills/skill_db/bundles/sha256/${"b".repeat(
            64,
          )}.zip`,
        ],
      );
      await client.query(
        `UPDATE skill_versions
            SET status = 'published', semantic_version = '1.0.0',
                published_at = now()
          WHERE id = 'version:db-integrity-valid'`,
      );
      await client.query(
        `UPDATE skills
            SET current_published_version_id = 'version:db-integrity-valid'
          WHERE id = 'skill:db-integrity'`,
      );
      await expect(
        client.query(
          `UPDATE skill_versions
              SET change_summary = 'mutated'
            WHERE id = 'version:db-integrity-valid'`,
        ),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
