import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import { PostgresPublicProjectionDirectory } from "@skillplane/control-plane";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PublicSkillProjectionService } from "../../src/public-projections.js";

describe("global public projection current-version selection", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const workspaceId = `workspace:projection-current-${suffix}`;
  const workspaceSlug = `projection-current-${suffix}`;
  const skillId = `skill:projection-current-${suffix}`;
  const skillSlug = `projection-current-${suffix}`;
  const oldVersionId = `skill-version:a-old-${suffix}`;
  const currentVersionId = `skill-version:z-current-${suffix}`;
  const publishedAt = "2026-08-30T12:00:00.000Z";
  let pool: Pool;

  beforeAll(async () => {
    const databaseUrl = await resolveTestDatabaseUrl();
    await migrateDatabase(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    await pool.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Projection current fixture')`,
      [workspaceId, workspaceSlug],
    );
    const directory = new PostgresPublicProjectionDirectory(pool);
    for (const [versionId, currentPointer, semanticVersion, revision] of [
      [oldVersionId, oldVersionId, "1.0.0", 1],
      [currentVersionId, currentVersionId, "2.0.0", 2],
    ] as const) {
      await directory.publish({
        workspaceId,
        workspaceSlug,
        skillId,
        skillSlug,
        versionId,
        currentVersionId: currentPointer,
        semanticVersion,
        digest: `sha256:${String(revision).repeat(64)}`,
        objectKey: `public/${versionId}.zip`,
        publishedAt,
        projectionSequence: revision,
        searchText: "tied timestamp",
        document: {
          skill: {
            id: skillId,
            workspaceId,
            slug: skillSlug,
            name: "Projection current fixture",
            description: "Tied source timestamps",
            tags: ["projection"],
            visibility: "public",
            currentPublishedVersionId: currentPointer,
          },
          version: {
            id: versionId,
            workspaceId,
            skillId,
            revision,
            semanticVersion,
            publishedAt,
          },
        },
      });
    }
    /* The historical row still contains its original self-pointer. The
       skill-wide head, not mutable history, decides the current version. */
    await expect(
      pool.query<{ pointer: string }>(
        `SELECT document->'skill'->>'currentPublishedVersionId' AS pointer
           FROM public_skill_projections
          WHERE workspace_id = $1 AND skill_id = $2 AND version_id = $3`,
        [workspaceId, skillId, oldVersionId],
      ),
    ).resolves.toMatchObject({ rows: [{ pointer: oldVersionId }] });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await pool.end();
  });

  it("uses the regional current pointer instead of UUID order when timestamps tie", async () => {
    const service = new PublicSkillProjectionService(
      pool,
      {} as never,
      "public-projection-cursor-secret-000000000000",
    );

    const current = await service.getCurrent(workspaceSlug, skillSlug);
    const byId = await service.getCurrentBySkillId(skillId);
    const discovery = await service.discover({ query: "", tags: [] });
    const versions = await service.listVersions(workspaceSlug, skillSlug);

    expect(current.version.id).toBe(currentVersionId);
    expect(byId.version.id).toBe(currentVersionId);
    expect(discovery.skills.map((skill) => skill.currentVersionId)).toContain(
      currentVersionId,
    );
    expect(versions.map((version) => version.id)).toEqual([
      currentVersionId,
      oldVersionId,
    ]);
  });
});
