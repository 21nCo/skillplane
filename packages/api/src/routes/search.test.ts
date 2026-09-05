import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ApiEnvironment } from "../context.js";
import { toApiError } from "../errors.js";
import { registerSkillSearchRoutes } from "./search.js";

function projectedSearchApp(discover: ReturnType<typeof vi.fn>) {
  const app = new Hono<ApiEnvironment>();
  app.use("*", async (context, next) => {
    context.set("requestId", "req_projected_search");
    context.set("services", {
      publicProjectionService: { discover },
    } as never);
    await next();
  });
  registerSkillSearchRoutes(app);
  app.onError((error, context) => {
    const response = toApiError(context, error);
    return context.json(response.body, response.status);
  });
  return app;
}

describe("projected skill search filters", () => {
  it.each([
    ["visibility=private", "visibility"],
    ["visibilities=public%2Cworkspace", "visibility"],
    ["state=archived", "state"],
    ["state=all", "state"],
  ])("rejects unsupported global filter %s", async (query, field) => {
    const discover = vi.fn();
    const response = await projectedSearchApp(discover).request(
      `/api/v1/skills/search?${query}`,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_FAILED", details: { field } },
    });
    expect(discover).not.toHaveBeenCalled();
  });

  it("accepts an explicit public active filter", async () => {
    const discover = vi.fn(async () => ({ skills: [], nextCursor: null }));
    const response = await projectedSearchApp(discover).request(
      "/api/v1/skills/search?visibility=public&state=active",
    );

    expect(response.status).toBe(200);
    expect(discover).toHaveBeenCalledOnce();
  });
});
