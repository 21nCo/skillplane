import {
  PostgresPublicProjectionDirectory,
  PostgresWorkspaceMigrationOperations,
  type WorkspaceMigrationObjectStore,
} from "@skillplane/control-plane";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";

class MemoryObjects implements WorkspaceMigrationObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async read(key: string): Promise<Uint8Array> {
    const value = this.objects.get(key);
    if (!value) throw new Error(`Missing migration object ${key}`);
    return value.slice();
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes.slice());
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

describe("concrete workspace migration rollback", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const workspaceId = `workspace:migration-${suffix}`;
  const skillId = `skill:migration-${suffix}`;
  const versionId = `skill-version:migration-${suffix}`;
  const bundleKey = `workspaces/${workspaceId}/skills/${skillId}/bundles/sha256/${"0".repeat(64)}.zip`;
  const targetDatabase = `skillplane_workspace_migration_${suffix}_test`;
  let sourceUrl = "";
  let targetUrl = "";
  let source: Pool | null = null;
  let target: Pool | null = null;
  let admin: Pool | null = null;

  beforeAll(async () => {
    sourceUrl = await resolveTestDatabaseUrl();
    await migrateDatabase(sourceUrl);
    const sourceAddress = new URL(sourceUrl);
    const adminAddress = new URL(sourceUrl);
    adminAddress.pathname = "/postgres";
    admin = new Pool({ connectionString: adminAddress.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${targetDatabase}" TEMPLATE template0`);
    sourceAddress.pathname = `/${targetDatabase}`;
    targetUrl = sourceAddress.toString();
    await migrateDatabase(targetUrl);
    source = new Pool({ connectionString: sourceUrl, max: 5 });
    target = new Pool({ connectionString: targetUrl, max: 3 });
    await source.query(
      `CREATE TABLE IF NOT EXISTS __datafn_meta (
         id text PRIMARY KEY,
         namespace text NOT NULL,
         next_server_seq integer NOT NULL
       )`,
    );
    await source.query(
      `INSERT INTO __datafn_meta (id, namespace, next_server_seq)
       VALUES ($1, $2, 7)
       ON CONFLICT (id) DO UPDATE
         SET namespace = EXCLUDED.namespace,
             next_server_seq = EXCLUDED.next_server_seq`,
      [`datafn-meta:${suffix}`, workspaceId],
    );
    await source.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Migration rollback fixture')`,
      [workspaceId, `migration-${suffix}`],
    );
    await source.query(
      `INSERT INTO skills
         (id, workspace_id, slug, name, description, tags)
       VALUES ($1, $2, 'rollback-fixture', 'Rollback fixture', '', '{}')`,
      [skillId, workspaceId],
    );
    await source.query(
      `INSERT INTO skill_versions
         (id, workspace_id, skill_id, revision, semantic_version, status,
          source, content_digest, r2_object_key, bundle_byte_size, manifest,
          change_summary, created_by_actor_type, created_by_actor_id, published_at)
       VALUES ($1, $2, $3, 1, '1.0.0', 'published', 'import', $4, $5, 1,
               $6, 'Migration fixture', 'system', $7, now())`,
      [
        versionId,
        workspaceId,
        skillId,
        `sha256:${"0".repeat(64)}`,
        bundleKey,
        {
          formatVersion: 1,
          digest: `sha256:${"0".repeat(64)}`,
          byteSize: 1,
          expandedByteSize: 1,
          fileCount: 1,
          files: [],
        },
        `fixture:${suffix}`,
      ],
    );
    await source.query(
      "UPDATE skills SET current_published_version_id = $2 WHERE id = $1",
      [skillId, versionId],
    );
    await source.query(
      `INSERT INTO skill_version_files
         (id, workspace_id, skill_version_id, path, content_type, byte_size,
          sha256, r2_object_key)
       VALUES ($1, $2, $3, 'SKILL.md', 'text/markdown', 1, $4, $5)`,
      [
        `skill-version-file:${suffix}`,
        workspaceId,
        versionId,
        "0".repeat(64),
        `${bundleKey}/SKILL.md`,
      ],
    );
  }, 90_000);

  afterAll(async () => {
    if (source) {
      const client = await source.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query("DELETE FROM __datafn_meta WHERE namespace = $1", [
          workspaceId,
        ]);
        await client.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await source.end();
    }
    await target?.end();
    if (admin) {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [targetDatabase],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${targetDatabase}"`);
      await admin.end();
    }
  }, 30_000);

  it("removes a copied published version and file only through the scoped drill", async () => {
    if (!source || !target) throw new Error("Migration fixture unavailable");
    await expect(
      target.query<{ relation: string | null }>(
        "SELECT to_regclass('public.__datafn_meta')::text AS relation",
      ),
    ).resolves.toMatchObject({ rows: [{ relation: null }] });
    const sourceObjects = new MemoryObjects();
    const targetObjects = new MemoryObjects();
    sourceObjects.objects.set(bundleKey, new Uint8Array([0]));
    const operations = new PostgresWorkspaceMigrationOperations(
      source,
      target,
      source,
      sourceObjects,
      targetObjects,
    );
    const context = {
      namespace: workspaceId,
      sourceRegionId: "legacy",
      targetRegionId: "in-south",
      sourceEpoch: 1,
      movingEpoch: 2,
      recoveryFence: 1,
      recoveryOwnerId: `recovery:${suffix}`,
      recoveryLeaseExpiresAt: Date.now() + 60_000,
    };

    let rolledBack = false;
    await operations.quiesceSource(context);
    try {
      await operations.drainOutboxes(context);
      await operations.copyDatabase(context);
      await operations.copyDatabase(context);
      await operations.copyBundles(context);
      await expect(
        target.query(
          `SELECT next_server_seq
             FROM __datafn_meta
            WHERE namespace = $1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ next_server_seq: 7 }] });
      await expect(
        target.query("DELETE FROM skill_version_files WHERE workspace_id = $1", [
          workspaceId,
        ]),
      ).rejects.toMatchObject({ code: "55000" });

      await operations.rollbackSource({
        ...context,
        cause: new Error("rollback drill"),
      });
      rolledBack = true;
    } finally {
      if (!rolledBack) {
        await operations
          .rollbackSource({ ...context, cause: new Error("test cleanup") })
          .catch(() => undefined);
      }
    }

    await expect(
      target.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM skill_versions
          WHERE workspace_id = $1`,
        [workspaceId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    await expect(
      target.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM __datafn_meta
          WHERE namespace = $1`,
        [workspaceId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    expect(targetObjects.objects.has(bundleKey)).toBe(false);
  });

  it("rejects a pre-fence transaction that reaches workspace DML late", async () => {
    if (!source || !target) throw new Error("Migration fixture unavailable");
    const sourceObjects = new MemoryObjects();
    const targetObjects = new MemoryObjects();
    const operations = new PostgresWorkspaceMigrationOperations(
      source,
      target,
      source,
      sourceObjects,
      targetObjects,
    );
    const context = {
      namespace: workspaceId,
      sourceRegionId: "legacy",
      targetRegionId: "in-south",
      sourceEpoch: 1,
      movingEpoch: 2,
      recoveryFence: 1,
      recoveryOwnerId: `recovery:late-${suffix}`,
      recoveryLeaseExpiresAt: Date.now() + 60_000,
    };
    const delayed = await source.connect();
    const delayedDatafn = await source.connect();
    const drainEventId = `event:drain-${suffix}`;
    let rolledBack = false;
    try {
      await source.query(
        "DELETE FROM regional_workspace_migration_fences WHERE workspace_id = $1",
        [workspaceId],
      );
      await source.query(
        `INSERT INTO regional_projection_outbox
           (id, workspace_id, event_type, payload, fencing_epoch, sequence)
         SELECT $1, $2, 'resource_route.upsert', '{}'::jsonb, 1,
                COALESCE(max(sequence), 0) + 1
           FROM regional_projection_outbox
          WHERE workspace_id = $2`,
        [drainEventId, workspaceId],
      );
      await delayed.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await delayed.query("SELECT 1");
      await delayedDatafn.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await delayedDatafn.query("SELECT 1");
      await operations.quiesceSource(context);

      await expect(
        delayed.query(
          `INSERT INTO skills
             (id, workspace_id, slug, name, description, tags)
           VALUES ($1, $2, 'late-write', 'Late write', '', '{}')`,
          [`skill:late-${suffix}`, workspaceId],
        ),
      ).rejects.toMatchObject({ code: "40001" });
      await expect(
        delayedDatafn.query(
          `INSERT INTO __datafn_meta (id, namespace, next_server_seq)
           VALUES ($1, $2, 8)`,
          [`datafn-meta:late-${suffix}`, workspaceId],
        ),
      ).rejects.toMatchObject({ code: "40001" });
      await Promise.all([delayed.query("ROLLBACK"), delayedDatafn.query("ROLLBACK")]);

      await expect(
        source.query(
          `INSERT INTO __datafn_meta (id, namespace, next_server_seq)
           VALUES ($1, $2, 8)`,
          [`datafn-meta:fenced-${suffix}`, workspaceId],
        ),
      ).rejects.toMatchObject({ code: "55000" });

      await expect(
        source.query(
          `UPDATE regional_projection_outbox
              SET processed_at = now()
            WHERE id = $1`,
          [drainEventId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        source.query(
          `INSERT INTO regional_projection_outbox
             (id, workspace_id, event_type, payload, fencing_epoch, sequence)
           SELECT $1, $2, 'resource_route.upsert', '{}'::jsonb, 1,
                  COALESCE(max(sequence), 0) + 1
             FROM regional_projection_outbox
            WHERE workspace_id = $2`,
          [`event:late-outbox-${suffix}`, workspaceId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await operations.drainOutboxes(context);
      await operations.rollbackSource({
        ...context,
        cause: new Error("late-write test cleanup"),
      });
      rolledBack = true;
    } finally {
      await Promise.all([
        delayed.query("ROLLBACK").catch(() => undefined),
        delayedDatafn.query("ROLLBACK").catch(() => undefined),
      ]);
      delayed.release();
      delayedDatafn.release();
      if (!rolledBack) {
        await operations
          .rollbackSource({ ...context, cause: new Error("test cleanup") })
          .catch(() => undefined);
      }
    }
  });

  it("rejects a read-committed write admitted before a move away and back", async () => {
    if (!source || !target) throw new Error("Migration fixture unavailable");
    const sourceObjects = new MemoryObjects();
    const targetObjects = new MemoryObjects();
    sourceObjects.objects.set(bundleKey, new Uint8Array([0]));
    const moveAway = new PostgresWorkspaceMigrationOperations(
      source,
      target,
      source,
      sourceObjects,
      targetObjects,
    );
    const moveBack = new PostgresWorkspaceMigrationOperations(
      target,
      source,
      source,
      targetObjects,
      sourceObjects,
    );
    const awayContext = {
      namespace: workspaceId,
      sourceRegionId: "legacy",
      targetRegionId: "in-south",
      sourceEpoch: 1,
      movingEpoch: 2,
      recoveryFence: 1,
      recoveryOwnerId: `recovery:away-${suffix}`,
      recoveryLeaseExpiresAt: Date.now() + 60_000,
    };
    const backContext = {
      ...awayContext,
      sourceRegionId: "in-south",
      targetRegionId: "legacy",
      sourceEpoch: 2,
      movingEpoch: 3,
      recoveryFence: 2,
      recoveryOwnerId: `recovery:back-${suffix}`,
    };
    const delayed = await source.connect();
    let awayResumed = false;
    let backResumed = false;
    try {
      await delayed.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await delayed.query("SELECT 1");

      await moveAway.quiesceSource(awayContext);
      await moveAway.drainOutboxes(awayContext);
      await moveAway.resumeTarget(awayContext);
      awayResumed = true;

      await moveBack.quiesceSource(backContext);
      await moveBack.drainOutboxes(backContext);
      await moveBack.resumeTarget(backContext);
      backResumed = true;

      await expect(
        delayed.query(
          `INSERT INTO skills
             (id, workspace_id, slug, name, description, tags)
           VALUES ($1, $2, 'prior-generation', 'Prior generation', '', '{}')`,
          [`skill:prior-generation-${suffix}`, workspaceId],
        ),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await delayed.query("ROLLBACK").catch(() => undefined);
      delayed.release();
      if (!backResumed) {
        await moveBack
          .rollbackSource({ ...backContext, cause: new Error("test cleanup") })
          .catch(() => undefined);
      }
      if (!awayResumed) {
        await moveAway
          .rollbackSource({ ...awayContext, cause: new Error("test cleanup") })
          .catch(() => undefined);
      }
    }
  });

  it("uses the current workspace slug after a projection cached an older slug", async () => {
    if (!target) throw new Error("Migration fixture unavailable");
    const publicWorkspace = `workspace:projection-slug-${suffix}`;
    const oldSlug = `projection-old-${suffix}`;
    const currentSlug = `projection-current-${suffix}`;
    const projectedSkillId = `skill:projection-slug-${suffix}`;
    await target.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Projection slug fixture')`,
      [publicWorkspace, oldSlug],
    );
    const cachedSlug = oldSlug;
    await target.query("UPDATE workspaces SET slug = $2 WHERE id = $1", [
      publicWorkspace,
      currentSlug,
    ]);

    const directory = new PostgresPublicProjectionDirectory(target);
    await directory.publish({
      workspaceId: publicWorkspace,
      workspaceSlug: cachedSlug,
      skillId: projectedSkillId,
      skillSlug: "projection-slug-fixture",
      versionId: `version:projection-slug-${suffix}`,
      currentVersionId: `version:projection-slug-${suffix}`,
      semanticVersion: "1.0.0",
      digest: `sha256:${"3".repeat(64)}`,
      objectKey: `public/${suffix}/projection-slug.zip`,
      projectionSequence: 1,
    });

    await expect(
      target.query<{ workspace_slug: string }>(
        `SELECT workspace_slug
           FROM public_skill_projections
          WHERE workspace_id = $1 AND skill_id = $2`,
        [publicWorkspace, projectedSkillId],
      ),
    ).resolves.toMatchObject({ rows: [{ workspace_slug: currentSlug }] });
    await target.query("DELETE FROM workspaces WHERE id = $1", [publicWorkspace]);
  });

  it("keeps newer public state when an older unpublish completes late", async () => {
    if (!target) throw new Error("Migration fixture unavailable");
    const publicWorkspace = `workspace:projection-${suffix}`;
    await target.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Projection ordering fixture')`,
      [publicWorkspace, `projection-${suffix}`],
    );
    const directory = new PostgresPublicProjectionDirectory(target);
    await directory.publish({
      workspaceId: publicWorkspace,
      workspaceSlug: `projection-${suffix}`,
      skillId: `skill:projection-${suffix}`,
      skillSlug: "projection-fixture",
      versionId: `version:projection-${suffix}`,
      currentVersionId: `version:projection-${suffix}`,
      semanticVersion: "2.0.0",
      digest: `sha256:${"1".repeat(64)}`,
      objectKey: `public/${suffix}/projection.zip`,
      projectionSequence: 2,
    });
    await directory.unpublish({
      workspaceId: publicWorkspace,
      skillId: `skill:projection-${suffix}`,
      versionId: `version:older-${suffix}`,
      projectionSequence: 1,
    });

    await expect(
      target.query<{ state: string; projection_sequence: string }>(
        `SELECT state, projection_sequence::text
           FROM public_skill_projections
          WHERE workspace_id = $1`,
        [publicWorkspace],
      ),
    ).resolves.toMatchObject({
      rows: [{ state: "published", projection_sequence: "2" }],
    });

    await directory.unpublish({
      workspaceId: publicWorkspace,
      skillId: `skill:projection-${suffix}`,
      versionId: `version:projection-${suffix}`,
      projectionSequence: 3,
    });
    await directory.publish({
      workspaceId: publicWorkspace,
      workspaceSlug: `projection-${suffix}`,
      skillId: `skill:projection-${suffix}`,
      skillSlug: "projection-fixture",
      versionId: `version:stale-${suffix}`,
      currentVersionId: `version:stale-${suffix}`,
      semanticVersion: "1.5.0",
      digest: `sha256:${"2".repeat(64)}`,
      objectKey: `public/${suffix}/stale-projection.zip`,
      projectionSequence: 2,
    });
    await expect(
      target.query<{
        current_version_id: string;
        head_state: string;
        projection_count: string;
      }>(
        `SELECT head.current_version_id, head.state AS head_state,
                (SELECT count(*)::text FROM public_skill_projections
                  WHERE workspace_id = $1) AS projection_count
           FROM public_skill_projection_heads head
          WHERE head.workspace_id = $1 AND head.skill_id = $2`,
        [publicWorkspace, `skill:projection-${suffix}`],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          current_version_id: `version:projection-${suffix}`,
          head_state: "unpublished",
          projection_count: "1",
        },
      ],
    });
    await target.query("DELETE FROM workspaces WHERE id = $1", [publicWorkspace]);
  });

  it("remaps compatibility placements when an existing database becomes control", async () => {
    if (!target) throw new Error("Migration fixture unavailable");
    const placedWorkspace = `workspace:placement-${suffix}`;
    await target.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Placement fixture')`,
      [placedWorkspace, `placement-${suffix}`],
    );
    await target.query(
      `INSERT INTO workspace_placements
         (workspace_id, region_id, epoch, state)
       VALUES ($1, 'legacy', 1, 'active')`,
      [placedWorkspace],
    );

    await migrateDatabase(targetUrl, {
      role: "control",
      initialWorkspaceRegion: "in-south",
      workspaceRegions: ["in-south"],
    });

    await expect(
      target.query<{ region_id: string }>(
        "SELECT region_id FROM workspace_placements WHERE workspace_id = $1",
        [placedWorkspace],
      ),
    ).resolves.toMatchObject({ rows: [{ region_id: "in-south" }] });
  });
});
