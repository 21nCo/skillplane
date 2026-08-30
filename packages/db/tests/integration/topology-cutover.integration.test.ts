import {
  backfillLegacyPublicSkillProjections,
  globalPublishedBundleKey,
  migrateLegacyWorkspaceBatch,
  type CutoverObjectStore,
} from "@skillplane/control-plane";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";

class MemoryObjects implements CutoverObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async read(input: string | { readonly key: string }): Promise<Uint8Array> {
    const key = typeof input === "string" ? input : input.key;
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error(`Missing object ${key}`);
    return bytes.slice();
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes.slice());
  }

  async putIfAbsent(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
  }): Promise<"created" | "exists"> {
    if (this.objects.has(input.key)) return "exists";
    this.objects.set(input.key, input.bytes.slice());
    return "created";
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return `sha256:${[...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("combined database topology cutover", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const legacyDatabase = `skillplane_cutover_source_${suffix}_test`;
  const cellDatabase = `skillplane_cutover_cell_${suffix}_test`;
  const workspaceId = `workspace:cutover-${suffix}`;
  const skillId = `skill:cutover-${suffix}`;
  const versionId = `skill-version:cutover-${suffix}`;
  let admin: Pool | null = null;
  let legacyUrl = "";
  let cellUrl = "";
  let bundleKey = "";
  let bundleDigest: `sha256:${string}` = `sha256:${"0".repeat(64)}`;
  const legacyObjects = new MemoryObjects();
  const cellObjects = new MemoryObjects();
  const publicObjects = new MemoryObjects();

  beforeAll(async () => {
    const testUrl = await resolveTestDatabaseUrl();
    const adminAddress = new URL(testUrl);
    adminAddress.pathname = "/postgres";
    admin = new Pool({ connectionString: adminAddress.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${legacyDatabase}" TEMPLATE template0`);
    await admin.query(`CREATE DATABASE "${cellDatabase}" TEMPLATE template0`);
    const legacyAddress = new URL(testUrl);
    legacyAddress.pathname = `/${legacyDatabase}`;
    legacyUrl = legacyAddress.toString();
    const cellAddress = new URL(testUrl);
    cellAddress.pathname = `/${cellDatabase}`;
    cellUrl = cellAddress.toString();
    await migrateDatabase(legacyUrl);
    await migrateDatabase(cellUrl, { role: "regional" });

    const bundle = new TextEncoder().encode("canonical legacy public bundle");
    bundleDigest = await sha256(bundle);
    bundleKey = `workspaces/${workspaceId}/skills/${skillId}/bundles/sha256/${bundleDigest.slice("sha256:".length)}.zip`;
    legacyObjects.objects.set(bundleKey, bundle);
    const legacy = new Pool({ connectionString: legacyUrl, max: 1 });
    try {
      await legacy.query(
        `INSERT INTO workspaces (id, workspace_id, slug, name)
         VALUES ($1, $1, $2, 'Cutover fixture')`,
        [workspaceId, `cutover-${suffix}`],
      );
      await legacy.query(
        `INSERT INTO workspace_placements
           (workspace_id, region_id, epoch, state)
         VALUES ($1, 'legacy', 1, 'active')`,
        [workspaceId],
      );
      await legacy.query(
        `INSERT INTO skills
           (id, workspace_id, slug, name, description, tags, visibility,
            published_search_text)
         VALUES ($1, $2, 'public-fixture', 'Public fixture',
                 'Legacy public skill', ARRAY['cutover'], 'public',
                 'canonical legacy public bundle')`,
        [skillId, workspaceId],
      );
      await legacy.query(
        `INSERT INTO skill_versions
           (id, workspace_id, skill_id, revision, semantic_version, status,
            source, content_digest, r2_object_key, bundle_byte_size, manifest,
            change_summary, created_by_actor_type, created_by_actor_id,
            published_at)
         VALUES ($1, $2, $3, 1, '1.0.0', 'published', 'import', $4, $5, $6,
                 $7::jsonb, 'Legacy publication', 'system', $8, now())`,
        [
          versionId,
          workspaceId,
          skillId,
          bundleDigest,
          bundleKey,
          bundle.byteLength,
          JSON.stringify({
            formatVersion: 1,
            digest: bundleDigest,
            byteSize: bundle.byteLength,
            expandedByteSize: bundle.byteLength,
            fileCount: 1,
            files: [],
          }),
          `fixture:${suffix}`,
        ],
      );
      await legacy.query(
        "UPDATE skills SET current_published_version_id = $2 WHERE id = $1",
        [skillId, versionId],
      );
      await legacy.query(
        `INSERT INTO skill_version_files
           (id, workspace_id, skill_version_id, path, content_type, byte_size,
            sha256, r2_object_key)
         VALUES ($1, $2, $3, 'SKILL.md', 'text/markdown', $4, $5, $6)`,
        [
          `skill-version-file:${suffix}`,
          workspaceId,
          versionId,
          bundle.byteLength,
          bundleDigest.slice("sha256:".length),
          `${bundleKey}/SKILL.md`,
        ],
      );
    } finally {
      await legacy.end();
    }
  }, 90_000);

  afterAll(async () => {
    if (!admin) return;
    for (const database of [legacyDatabase, cellDatabase]) {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    }
    await admin.end();
  }, 30_000);

  it("copies and verifies populated workspaces before pruning the control source", async () => {
    await migrateDatabase(legacyUrl, {
      role: "control",
      initialWorkspaceRegion: "legacy",
      finalizePhysicalOwnership: false,
    });
    const control = new Pool({ connectionString: legacyUrl, max: 3 });
    const cell = new Pool({ connectionString: cellUrl, max: 3 });
    try {
      await control.query(
        `UPDATE topology_cutover_state
            SET state = 'copying', target_region_id = 'in-south',
                started_at = now(), updated_at = now()
          WHERE id = 'legacy-to-cells'`,
      );
      const first = await migrateLegacyWorkspaceBatch({
        control,
        source: control,
        target: cell,
        sourceObjects: legacyObjects,
        targetObjects: cellObjects,
        targetRegionId: "in-south",
      });
      expect(first.migrated).toHaveLength(1);
      expect(first.migrated[0]).toMatchObject({
        workspaceId,
        sourceRegionId: "legacy",
        targetRegionId: "in-south",
        rollbackTested: true,
      });
      expect(first.migrated[0]?.checks.every((check) => check.matched)).toBe(true);

      await expect(
        control.query("UPDATE skills SET name = 'stale write' WHERE id = $1", [
          skillId,
        ]),
      ).rejects.toMatchObject({ code: "55000" });

      const projection = await backfillLegacyPublicSkillProjections({
        control,
        regional: cell,
        regionalObjects: cellObjects,
        publicObjects,
        regionId: "in-south",
      });
      expect(projection.projected).toBe(1);
      const publicKey = globalPublishedBundleKey({
        workspaceId,
        skillId,
        versionId,
        digest: bundleDigest,
      });
      expect(publicObjects.objects.get(publicKey)).toEqual(
        legacyObjects.objects.get(bundleKey),
      );

      await control.query("UPDATE workspaces SET slug = $2 WHERE id = $1", [
        workspaceId,
        `cutover-renamed-${suffix}`,
      ]);
      await expect(
        control.query<{ workspace_slug: string }>(
          `SELECT workspace_slug
             FROM public_skill_projections
            WHERE workspace_id = $1 AND version_id = $2`,
          [workspaceId, versionId],
        ),
      ).resolves.toMatchObject({
        rows: [{ workspace_slug: `cutover-renamed-${suffix}` }],
      });

      const resumed = await migrateLegacyWorkspaceBatch({
        control,
        source: control,
        target: cell,
        sourceObjects: legacyObjects,
        targetObjects: cellObjects,
        targetRegionId: "in-south",
      });
      expect(resumed.migrated).toHaveLength(0);
      expect(resumed.verifiedExisting).toHaveLength(1);
      expect(resumed.verifiedExisting[0]?.checks.every((check) => check.matched)).toBe(
        true,
      );
      await control.query(
        `UPDATE topology_cutover_state
            SET state = 'complete', completed_at = now(), updated_at = now()
          WHERE id = 'legacy-to-cells'`,
      );
      await expect(
        control.query("UPDATE skills SET name = 'late stale write' WHERE id = $1", [
          skillId,
        ]),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await Promise.allSettled([control.end(), cell.end()]);
    }

    await migrateDatabase(legacyUrl, {
      role: "control",
      initialWorkspaceRegion: "in-south",
    });
    const finalControl = new Pool({ connectionString: legacyUrl, max: 1 });
    const finalCell = new Pool({ connectionString: cellUrl, max: 1 });
    try {
      await expect(
        finalControl.query<{
          regional_table: string | null;
          region_id: string;
          cutover_state: string;
          projected: string;
        }>(
          `SELECT to_regclass('public.skills')::text AS regional_table,
                  placement.region_id,
                  cutover.state AS cutover_state,
                  (SELECT count(*)::text FROM public_skill_projections
                    WHERE workspace_id = $1) AS projected
             FROM workspace_placements placement
             JOIN topology_cutover_state cutover
               ON cutover.id = 'legacy-to-cells'
            WHERE placement.workspace_id = $1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            regional_table: null,
            region_id: "in-south",
            cutover_state: "complete",
            projected: "1",
          },
        ],
      });
      await expect(
        finalCell.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM skill_versions
            WHERE workspace_id = $1 AND status = 'published'`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: "1" }] });
    } finally {
      await Promise.allSettled([finalControl.end(), finalCell.end()]);
    }
  }, 120_000);
});
