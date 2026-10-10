import { Hono } from "hono";
import { expect, it } from "vitest";
import type { ApiEnvironment } from "./context.js";
import type { ApiServices } from "./services.js";
import { registerSkillRoutes } from "./routes/skills.js";

it.each(["projected", "regional"])(
  "invalidates %s version pages when history changes",
  async (backend) => {
    const version = (id: string, revision: number) => ({
      id,
      revision,
      digest: `sha256:${"a".repeat(64)}`,
      semanticVersion: `${revision}.0.0`,
      status: "published",
      changeSummary: "Published version",
      manifest: {},
    });
    // Equal content digests are valid for distinct immutable version identities.
    const current = version("current", 3);
    const middle = version("middle", 2);
    let versions = [current, version("old", 1)];
    const services = {
      ...(backend === "projected"
        ? { publicProjectionService: { listVersions: async () => versions } }
        : {}),
      skillService: { getPublicBySlug: async () => ({ id: "skill:one" }) },
      skillVersionService: { list: async () => versions },
    } as unknown as ApiServices;
    const app = new Hono<ApiEnvironment>();
    app.use("*", async (context, next) => {
      context.set("services", services);
      context.set("requestId", crypto.randomUUID());
      await next();
    });
    registerSkillRoutes(app);
    const url = "/api/v1/skills/public/workspace/skill/versions?limit=2";
    const initial = await app.request(url);
    expect(initial.status).toBe(200);
    const etag = initial.headers.get("etag");
    if (!etag) throw new Error("Expected initial ETag");
    expect(
      (await app.request(url, { headers: { "if-none-match": etag } })).status,
    ).toBe(304);
    versions = [current, middle];
    const changed = await app.request(url, { headers: { "if-none-match": etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect(
      (await changed.json()).data.versions.map((entry: { id: string }) => entry.id),
    ).toEqual(["current", "middle"]);
    const updatedEtag = changed.headers.get("etag");
    if (!updatedEtag) throw new Error("Expected changed ETag");
    versions = [current, { ...middle, changeSummary: "Corrected projection metadata" }];
    expect(
      (await app.request(url, { headers: { "if-none-match": updatedEtag } })).status,
    ).toBe(200);
  },
);
