import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@skillplane/domain";
import type { ApiEnvironment } from "../context.js";
import { toApiError } from "../errors.js";
import { requiredAction } from "../middleware/authorization.js";
import { registerCompositionRoutes } from "./composition.js";

const principal: Principal = {
  kind: "user",
  role: "editor",
  userId: "user",
  actorId: "user",
  sessionId: "session",
  workspaceId: "workspace",
};
const path = "/api/v1/skills/parent/versions/version/repair-bundle";
function fixture(authenticated = true) {
  const upgradeBundle = vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    digest: "sha256:root",
  }));
  const app = new Hono<ApiEnvironment>();
  app.use("*", async (c, next) => {
    c.set("requestId", "repair-test");
    c.set("principal", authenticated ? principal : null);
    c.set("services", { compositionService: { upgradeBundle } } as never);
    await next();
  });
  registerCompositionRoutes(app);
  app.onError((error, c) => {
    const response = toApiError(c, error);
    return c.json(response.body, response.status);
  });
  return { app, upgradeBundle };
}
describe("authored bundle repair route", () => {
  it("requires write authorization even for GET and HEAD", () => {
    expect(requiredAction(path, "GET")).toBe("skills:write");
    expect(requiredAction(path, "HEAD")).toBe("skills:write");
    expect(requiredAction(path.replace("repair-bundle", "bundle"), "GET")).toBe(
      "skills:read",
    );
  });
  it("rejects anonymous access before reading the bundle", async () => {
    const { app, upgradeBundle } = fixture(false);
    expect((await app.request(path)).status).toBe(401);
    expect(upgradeBundle).not.toHaveBeenCalled();
  });
  it("returns only the authorized authored root without cacheable execution content", async () => {
    const { app, upgradeBundle } = fixture();
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(upgradeBundle).toHaveBeenCalledExactlyOnceWith(
      "version",
      "parent",
      principal,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
