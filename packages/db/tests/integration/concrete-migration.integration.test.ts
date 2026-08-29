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
    source = new Pool({ connectionString: sourceUrl, max: 3 });
    target = new Pool({ connectionString: targetUrl, max: 3 });
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
      await operations.copyDatabase(context);
      await operations.copyDatabase(context);
      await operations.copyBundles(context);
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
    expect(targetObjects.objects.has(bundleKey)).toBe(false);
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
    });

    await expect(
      target.query<{ region_id: string }>(
        "SELECT region_id FROM workspace_placements WHERE workspace_id = $1",
        [placedWorkspace],
      ),
    ).resolves.toMatchObject({ rows: [{ region_id: "in-south" }] });
  });
});
