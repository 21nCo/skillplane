import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ApiEnvironment } from "../context.js";
import { authorizationMiddleware } from "./authorization.js";

describe("regional public skill authorization", () => {
  it("leaves a trusted routed version read unauthenticated for visibility checks", async () => {
    const app = new Hono<ApiEnvironment>();
    app.use("*", async (context, next) => {
      context.set("services", null);
      context.set("session", null);
      context.set("servicePrincipal", null);
      await next();
    });
    app.use("*", authorizationMiddleware());
    app.get("/api/v1/skills/:skillId/versions/:versionId", (context) =>
      context.json({ principal: context.get("principal") }),
    );

    const response = await app.request(
      "/api/v1/skills/skill%3Aone/versions/version%3Aone",
      {
        headers: {
          "x-skillplane-routed-workspace-id": "workspace:one",
          "x-skillplane-public-skill-read": "1",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ principal: null });
  });
});
