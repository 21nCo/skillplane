import { createAuthfnSchema, createDatabaseClient } from "@skillplane/db";
import { createUser, issueSession, type AuthFnConfig } from "@authfn/core";
import { Pool } from "pg";

export interface TenantFixture {
  readonly workspaceId: string;
  readonly userId: string;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly skillId: string;
  readonly contextId: string;
}

export async function seedTenantFixture(
  databaseUrl: string,
  suffix: string,
  options: { role?: "viewer" | "editor" | "admin" | "owner" } = {},
): Promise<TenantFixture> {
  const database = createDatabaseClient({
    connectionString: databaseUrl,
    applicationName: `skillplane-fixture-${suffix}`,
    maxConnections: 2,
  });
  try {
    const now = new Date();
    const userId = `user:${suffix}`;
    const workspaceId = `workspace:${suffix}`;
    const skillId = `skill:${suffix}`;
    const contextId = `context:${suffix}`;
    const authConfig: AuthFnConfig = {
      database: database.adapter,
      plugins: [],
      namespace: "authfn",
    };
    createAuthfnSchema({ database: database.adapter });
    await createUser(authConfig, {
      id: userId,
      primaryEmail: `${suffix}@example.test`,
      emailVerifiedAt: now,
      metadata: { fixture: true },
    });
    const issued = await issueSession(
      authConfig,
      {},
      {
        userId,
        primaryEmail: `${suffix}@example.test`,
        methods: ["email-otp"],
      },
    );
    await database.pool.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, $3)`,
      [workspaceId, `workspace-${suffix}`, `Workspace ${suffix}`],
    );
    await database.pool.query(
      `INSERT INTO workspace_memberships
         (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, $4)`,
      [`membership:${suffix}`, workspaceId, userId, options.role ?? "owner"],
    );
    await database.pool.query(
      `INSERT INTO skills
         (id, workspace_id, slug, name, description, tags, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        skillId,
        workspaceId,
        `pr-review-${suffix}`,
        `PR Review ${suffix}`,
        `Tenant ${suffix} private review guidance`,
        ["review", suffix],
        userId,
      ],
    );
    const fixtureVersionId = `skill-version:${suffix}`;
    const fixtureDigest = `sha256:${"0".repeat(64)}`;
    await database.pool.query(
      `INSERT INTO skill_versions
         (id, workspace_id, skill_id, revision, semantic_version, status,
         source, content_digest, r2_object_key, bundle_byte_size, manifest,
          change_summary, created_by_actor_type, created_by_actor_id, published_at)
       VALUES (
         $1, $2, $3, 1, '1.0.0', 'published', 'import', $4, $5, 1,
         $6, 'Tenant search fixture', 'system', $7, now()
       )`,
      [
        fixtureVersionId,
        workspaceId,
        skillId,
        fixtureDigest,
        `workspaces/${workspaceId}/skills/${skillId}/bundles/sha256/${"0".repeat(
          64,
        )}.zip`,
        {
          formatVersion: 1,
          digest: fixtureDigest,
          byteSize: 1,
          expandedByteSize: 1,
          fileCount: 0,
          files: [],
        },
        `fixture:${suffix}`,
      ],
    );
    await database.pool.query(
      `UPDATE skills
          SET current_published_version_id = $2,
              published_search_text = $3,
              next_revision = 2
        WHERE id = $1`,
      [skillId, fixtureVersionId, `Review guidance for tenant ${suffix}`],
    );
    await database.pool.query(
      `INSERT INTO skill_contexts
         (id, workspace_id, skill_id, slug, name, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        contextId,
        workspaceId,
        skillId,
        `project-${suffix}`,
        `Project ${suffix}`,
        `Private context for ${suffix}`,
      ],
    );
    return {
      workspaceId,
      userId,
      sessionToken: issued.sessionToken,
      csrfToken: issued.csrfToken,
      skillId,
      contextId,
    };
  } finally {
    await database.close();
  }
}

export async function purgeTenantFixture(
  databaseUrl: string,
  suffix: string,
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const userId = `user:${suffix}`;
    await client.query("BEGIN");
    const workspaces = await client.query<{ id: string }>(
      `SELECT id
         FROM workspaces
        WHERE id = $1 OR personal_owner_user_id = $2 OR created_by_user_id = $2`,
      [`workspace:${suffix}`, userId],
    );
    const workspaceIds = workspaces.rows.map((row) => row.id);
    // Production immutability triggers correctly reject fixture deletion.
    // Disable triggers only for this session while removing the immutable
    // leaves. ALTER TABLE would take relation-wide locks and can deadlock with
    // another integration file that is still writing an unrelated tenant.
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "DELETE FROM skill_version_files WHERE workspace_id = ANY($1::text[])",
      [workspaceIds],
    );
    await client.query(
      "DELETE FROM context_note_revisions WHERE workspace_id = ANY($1::text[])",
      [workspaceIds],
    );
    await client.query(
      "DELETE FROM context_knowledge_revisions WHERE workspace_id = ANY($1::text[])",
      [workspaceIds],
    );
    await client.query(
      "DELETE FROM skill_versions WHERE workspace_id = ANY($1::text[])",
      [workspaceIds],
    );
    await client.query(
      `DELETE FROM audit_events
        WHERE workspace_id = ANY($1::text[])`,
      [workspaceIds],
    );
    await client.query("SET LOCAL session_replication_role = origin");
    await client.query(
      `DELETE FROM workspaces
        WHERE id = $1 OR personal_owner_user_id = $2 OR created_by_user_id = $2`,
      [`workspace:${suffix}`, userId],
    );
    await client.query("DELETE FROM authfn_users WHERE id = $1", [userId]);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
