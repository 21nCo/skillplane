import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ApiEnvironment, ApiServiceProvider, ApiServices } from "../context.js";
import { authenticationMiddleware } from "./authentication.js";

function requestScopedProvider() {
  const services = {
    auth: {
      provider: {
        authenticate: vi.fn(async () => null),
      },
    },
  } as unknown as ApiServices;
  const release = vi.fn(async () => undefined);
  const provider = Object.assign(async () => services, {
    release,
  }) satisfies ApiServiceProvider;
  return { provider, release, services };
}

describe("authenticationMiddleware service lifetime", () => {
  it("releases request-scoped services after a successful response", async () => {
    const { provider, release, services } = requestScopedProvider();
    const app = new Hono<ApiEnvironment>();
    app.use("*", authenticationMiddleware(provider));
    app.get("/probe", (context) => context.text("ok"));

    const response = await app.request("/probe");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(services);
  });

  it("releases request-scoped services when downstream handling fails", async () => {
    const { provider, release, services } = requestScopedProvider();
    const app = new Hono<ApiEnvironment>();
    app.use("*", authenticationMiddleware(provider));
    app.get("/probe", () => {
      throw new Error("probe failure");
    });
    app.onError((_, context) => context.text("failed", 500));

    const response = await app.request("/probe");

    expect(response.status).toBe(500);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(services);
  });
});
