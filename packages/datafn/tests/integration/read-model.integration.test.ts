import { authfn } from "authfn";
import {
  createDatabaseClient,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "@skillplane/db";
import {
  purgeTenantFixture,
  seedTenantFixture,
  type TenantFixture,
} from "@skillplane/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSkillplaneDatafnServer } from "../../src/server.js";

describe.each(["combined", "regional"] as const)(
  "DataFn %s database adapter",
  (role) => {
    // Dedicated tenant-A skill whose published version carries a non-empty
    // nested manifest array and date columns, used to prove relation projection
    // preserves nested arrays and Date values instead of reducing them to `{}`.
    const nestedSkillId = "skill:datafn-a-nested";
    const nestedVersionId = "skill-version:datafn-a-nested";
    const nestedManifestFiles = [
      { path: "SKILL.md", sha256: "a".repeat(64), byteSize: 1 },
      { path: "skill.json", sha256: "b".repeat(64), byteSize: 1 },
    ];
    let databaseUrl: string;
    let tenantA: TenantFixture;
    let tenantB: TenantFixture;
    let close: () => Promise<void>;
    let handle: (request: Request) => Promise<Response>;

    beforeAll(async () => {
      databaseUrl = await resolveTestDatabaseUrl();
      await migrateDatabase(databaseUrl);
      await purgeTenantFixture(databaseUrl, "datafn-a");
      await purgeTenantFixture(databaseUrl, "datafn-b");
      tenantA = await seedTenantFixture(databaseUrl, "datafn-a");
      tenantB = await seedTenantFixture(databaseUrl, "datafn-b");
      const controlDatabase = createDatabaseClient({
        connectionString: databaseUrl,
        role: "control",
      });
      const database = createDatabaseClient({ connectionString: databaseUrl, role });
      // Keep revision 1 published while adding a newer draft to exercise history order.
      await database.pool.query(
        `INSERT INTO skill_versions
           (id, workspace_id, skill_id, revision, base_version_id, status, source, content_digest,
            r2_object_key, bundle_byte_size, manifest, change_summary,
            created_by_actor_type, created_by_actor_id)
         SELECT $1, workspace_id, skill_id, 2, id, 'draft', source, content_digest,
                r2_object_key, bundle_byte_size, manifest, 'History ordering fixture',
                created_by_actor_type, created_by_actor_id
           FROM skill_versions WHERE skill_id = $2 AND revision = 1`,
        [`skill-version:datafn-a-revision-2`, tenantA.skillId],
      );
      await database.pool.query(`UPDATE skills SET next_revision = 3 WHERE id = $1`, [
        tenantA.skillId,
      ]);
      const nestedDigest = `sha256:${"a".repeat(64)}`;
      await database.pool.query(
        `INSERT INTO skills
           (id, workspace_id, slug, name, description, tags, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          nestedSkillId,
          tenantA.workspaceId,
          "nested-datafn-a",
          "Nested DataFn A",
          "Nested relation projection fixture",
          ["review", "nested"],
          tenantA.userId,
        ],
      );
      await database.pool.query(
        `INSERT INTO skill_versions
           (id, workspace_id, skill_id, revision, semantic_version, status,
            source, content_digest, r2_object_key, bundle_byte_size, manifest,
            change_summary, created_by_actor_type, created_by_actor_id, published_at)
         VALUES (
           $1, $2, $3, 1, '1.0.0', 'published', 'import', $4, $5, 2,
           $6, 'Nested manifest fixture', 'system', $7, now()
         )`,
        [
          nestedVersionId,
          tenantA.workspaceId,
          nestedSkillId,
          nestedDigest,
          `workspaces/${tenantA.workspaceId}/skills/${nestedSkillId}/bundles/sha256/${"a".repeat(
            64,
          )}.zip`,
          {
            formatVersion: 1,
            digest: nestedDigest,
            byteSize: 2,
            expandedByteSize: 4,
            fileCount: nestedManifestFiles.length,
            files: nestedManifestFiles,
          },
          "fixture:datafn-a-nested",
        ],
      );
      await database.pool.query(
        `UPDATE skills
            SET current_published_version_id = $2, next_revision = 2
          WHERE id = $1`,
        [nestedSkillId, nestedVersionId],
      );
      const auth = authfn({
        plugins: [],
        namespace: "authfn",
        basePath: "/auth",
      }).createServer({ database: controlDatabase.adapter });
      const server = await createSkillplaneDatafnServer({
        database,
        controlDatabase,
        auth: auth.provider,
      });
      handle = (request) => server.router.handle(request);
      close = async () => {
        await server.close();
        await database.close();
        await controlDatabase.close();
      };
    });

    afterAll(async () => {
      if (close) await close();
      await purgeTenantFixture(databaseUrl, "datafn-a");
      await purgeTenantFixture(databaseUrl, "datafn-b");
    });

    function request(tenant: TenantFixture, path: string, body?: unknown): Request {
      return new Request(`http://localhost${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${tenant.sessionToken}`,
          "content-type": "application/json",
          "x-skillplane-workspace-id": tenant.workspaceId,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    describe("DataFn tenant read model", () => {
      it("returns only rows from the authenticated workspace", async () => {
        const response = await handle(
          request(tenantA, "/datafn/query", {
            resource: "skills",
            version: 1,
            select: ["id", "name", "description"],
            limit: 20,
          }),
        );
        expect(response.status).toBe(200);
        const serialized = JSON.stringify(await response.json());
        expect(serialized).toContain(tenantA.skillId);
        expect(serialized).not.toContain(tenantB.skillId);
      });

      it("round-trips date-valued cursors across skill pages", async () => {
        const firstResponse = await handle(
          request(tenantA, "/datafn/query", {
            resource: "skills",
            version: 1,
            select: ["id", "updatedAt"],
            sort: ["-updatedAt", "id"],
            limit: 1,
          }),
        );
        expect(firstResponse.status).toBe(200);
        const firstPage = (await firstResponse.json()).result;
        expect(firstPage.data).toHaveLength(1);
        expect(firstPage.nextCursor).toMatchObject({
          updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
          id: expect.any(String),
        });

        const secondResponse = await handle(
          request(tenantA, "/datafn/query", {
            resource: "skills",
            version: 1,
            select: ["id", "updatedAt"],
            sort: ["-updatedAt", "id"],
            cursor: { after: firstPage.nextCursor },
            limit: 1,
          }),
        );
        expect(secondResponse.status).toBe(200);
        const secondPage = (await secondResponse.json()).result;
        expect(secondPage.data).toHaveLength(1);
        expect(secondPage.data[0].id).not.toBe(firstPage.data[0].id);
        const ordered = [firstPage.data[0], secondPage.data[0]] as {
          id: string;
          updatedAt: string;
        }[];
        expect(ordered).toEqual(
          [...ordered].toSorted((left, right) =>
            left.updatedAt === right.updatedAt
              ? left.id.localeCompare(right.id)
              : right.updatedAt.localeCompare(left.updatedAt),
          ),
        );
      });

      it("expands current skill version metadata in one tenant-filtered query", async () => {
        const response = await handle(
          request(tenantA, "/datafn/query", {
            resource: "skills",
            version: 1,
            select: ["*", "currentVersion.*"],
            filters: { id: tenantA.skillId },
            limit: 1,
          }),
        );

        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload).toMatchObject({
          ok: true,
          result: {
            data: [
              {
                id: tenantA.skillId,
                currentVersion: {
                  semanticVersion: "1.0.0",
                  bundleByteSize: 1,
                },
              },
            ],
          },
        });
        expect(payload.result.data[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        expect(payload.result.data[0].currentVersion.createdAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T/u,
        );
      });

      it("preserves nested relation dates and arrays when expanding currentVersion", async () => {
        const response = await handle(
          request(tenantA, "/datafn/query", {
            resource: "skills",
            version: 1,
            select: ["id", "tags", "currentVersion.*"],
            filters: { id: nestedSkillId },
            limit: 1,
          }),
        );
        expect(response.status).toBe(200);
        const skill = (await response.json()).result.data[0];
        expect(skill.id).toBe(nestedSkillId);
        // Top-level array survives relation projection.
        expect(skill.tags).toEqual(["review", "nested"]);
        const version = skill.currentVersion;
        // Nested relation Date columns serialize as ISO strings, not `{}`.
        expect(version.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        expect(version.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        // Nested arrays inside the expanded relation survive omission handling.
        expect(version.manifest.formatVersion).toBe(1);
        expect(version.manifest.files).toEqual(nestedManifestFiles);
      });

      it("reads descending version history through the domain model name with tenant isolation", async () => {
        const response = await handle(
          request(tenantA, "/datafn/query", {
            resource: "skillVersions",
            version: 1,
            select: ["*"],
            filters: { skillId: tenantA.skillId },
            sort: ["-revision"],
            limit: 100,
          }),
        );
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(
          payload.result.data.map((version: { revision: number }) => version.revision),
        ).toEqual([2, 1]);
        expect(payload.result.data).toMatchObject([
          { skillId: tenantA.skillId, revision: 2, status: "draft" },
          { skillId: tenantA.skillId, revision: 1, semanticVersion: "1.0.0" },
        ]);
        for (const version of payload.result.data) {
          expect(version.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
        }
        const foreign = await handle(
          request(tenantA, "/datafn/query", {
            resource: "skillVersions",
            version: 1,
            select: ["*"],
            filters: { skillId: tenantB.skillId },
            limit: 100,
          }),
        );
        expect(foreign.status).toBe(200);
        expect((await foreign.json()).result.data).toEqual([]);
      });

      it("denies generic mutations and secret-bearing resources", async () => {
        const mutation = await handle(
          request(tenantA, "/datafn/mutation", {
            resource: "skills",
            version: 1,
            operation: "merge",
            data: { id: tenantA.skillId, name: "Bypass" },
          }),
        );
        expect(mutation.status).toBe(403);

        const secret = await handle(
          request(tenantA, "/datafn/query", {
            resource: "authfnSessions",
            version: 1,
            select: ["id"],
          }),
        );
        expect([400, 403]).toContain(secret.status);
        expect(JSON.stringify(await secret.json())).not.toContain("tokenHash");
      });
    });
  },
);
