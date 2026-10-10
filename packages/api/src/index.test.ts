import { describe, expect, it } from "vitest";
import { createApiApp, MIDDLEWARE_ORDER } from "./index.js";

const fixedNow = () => new Date("2026-07-26T00:00:00.000Z");
const fixedRequestId = () => "req_phase_01";

const readyResult = {
  ok: true,
  checks: {
    configuration: { ok: true, code: "CONFIG_VALID", latencyMs: 1 },
    postgres: { ok: true, code: "POSTGRES_READY", latencyMs: 2 },
    objectStorage: { ok: true, code: "R2_READY", latencyMs: 3 },
  },
} as const;

describe("createApiApp", () => {
  it("serves liveness without calling dependency readiness", async () => {
    let readinessCalled = false;
    const app = createApiApp({
      now: fixedNow,
      requestId: fixedRequestId,
      readiness: async () => {
        readinessCalled = true;
        throw new Error("should not be called");
      },
    });

    const response = await app.request("/api/v1/health/live");

    expect(response.status).toBe(200);
    expect(readinessCalled).toBe(false);
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        service: "skillplane-app",
        status: "live",
        checkedAt: "2026-07-26T00:00:00.000Z",
      },
      meta: {
        requestId: "req_phase_01",
      },
    });
  });

  it("reports ready only after all real dependency probes pass", async () => {
    const app = createApiApp({
      now: fixedNow,
      requestId: fixedRequestId,
      readiness: async () => readyResult,
    });

    const response = await app.request("/api/v1/health/ready");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      data: {
        status: "ready",
        checks: readyResult.checks,
      },
    });
  });

  it("returns a redacted not-ready response when a dependency fails", async () => {
    const app = createApiApp({
      now: fixedNow,
      requestId: fixedRequestId,
      readiness: async () => ({
        ok: false,
        checks: {
          configuration: { ok: true, code: "CONFIG_VALID", latencyMs: 1 },
          postgres: {
            ok: false,
            code: "POSTGRES_UNAVAILABLE",
            latencyMs: 2,
          },
          objectStorage: { ok: true, code: "R2_READY", latencyMs: 3 },
        },
      }),
    });

    const response = await app.request("/api/v1/health/ready");
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("POSTGRES_UNAVAILABLE");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("password");
  });

  it("applies middleware in the declared order with security headers", async () => {
    const observed: string[] = [];
    const app = createApiApp({
      now: fixedNow,
      requestId: fixedRequestId,
      readiness: async () => readyResult,
      middlewareObserver: (name) => observed.push(name),
    });

    const response = await app.request("/api/v1/health/live");

    expect(observed).toEqual(MIDDLEWARE_ORDER);
    expect(response.headers.get("x-request-id")).toBe("req_phase_01");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("server-timing")).toMatch(/^app;dur=/);
  });

  it("returns a stable request-scoped error envelope for unknown routes", async () => {
    const app = createApiApp({
      requestId: fixedRequestId,
      readiness: async () => readyResult,
    });

    const response = await app.request("/api/v1/unknown");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "ROUTE_NOT_FOUND",
        message: "The requested API route does not exist",
        requestId: "req_phase_01",
      },
    });
  });
});
