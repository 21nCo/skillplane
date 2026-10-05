import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ApiEnvironment, ApiServices } from "../context.js";
import { rateLimitMiddleware } from "./rate-limit.js";

vi.mock("@skillplane/db", () => ({
  consumeRateLimit: vi.fn(async () => ({
    allowed: false,
    remaining: 0,
    retryAfterSeconds: 60,
  })),
}));

describe("regional DataFn rate limiting", () => {
  it("leaves verified-ticket traffic to the actor-aware DataFn limiter", async () => {
    const app = new Hono<ApiEnvironment>();
    app.use("*", async (context, next) => {
      context.set("services", { deploymentRole: "cell" } as ApiServices);
      context.set("session", null);
      context.set("servicePrincipal", null);
      await next();
    });
    app.use("*", rateLimitMiddleware());
    app.post("/datafn/query", (context) => context.json({ ok: true }));

    const response = await app.request("/datafn/query", {
      method: "POST",
      headers: { "x-datafn-route-ticket": "signed-ticket" },
    });

    expect(response.status).toBe(200);
  });

  it("retains the application limiter for unticketed traffic", async () => {
    const app = new Hono<ApiEnvironment>();
    app.use("*", async (context, next) => {
      context.set("requestId", "request:test");
      context.set("services", {
        deploymentRole: "gateway",
        controlDatabase: { pool: {} },
      } as unknown as ApiServices);
      context.set("session", null);
      context.set("servicePrincipal", null);
      await next();
    });
    app.use("*", rateLimitMiddleware());
    app.post("/datafn/query", (context) => context.json({ ok: true }));

    const response = await app.request("/datafn/query", { method: "POST" });

    expect(response.status).toBe(429);
  });
});
