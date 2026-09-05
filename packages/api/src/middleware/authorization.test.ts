import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ApiEnvironment } from "../context.js";
import { toApiError } from "../errors.js";
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

  it("preserves routing epoch validation when recording an authorization denial", async () => {
    const app = new Hono<ApiEnvironment>();
    app.use("*", async (context, next) => {
      context.set("requestId", "request:test");
      context.set("services", { database: {} } as never);
      context.set("session", null);
      context.set("servicePrincipal", {
        kind: "service",
        actorId: "service:reader",
        servicePrincipalId: "service:reader",
        workspaceId: "workspace:one",
        role: "viewer",
        scopes: ["skills:read"],
      });
      await next();
    });
    app.use("*", authorizationMiddleware());
    app.put("/api/v1/skills/:skillId", (context) => context.json({ ok: true }));
    app.onError((error, context) => {
      const response = toApiError(context, error);
      return context.json(response.body, response.status);
    });

    const response = await app.request("/api/v1/skills/skill%3Aone", {
      method: "PUT",
      headers: {
        "x-skillplane-routed-workspace-id": "workspace:one",
        "x-skillplane-routing-epoch": "malformed",
      },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });
});
