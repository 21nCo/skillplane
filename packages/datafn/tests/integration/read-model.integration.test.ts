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
