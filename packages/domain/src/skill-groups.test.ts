import { describe, it, expect } from "vitest";
import { groupMetadata, groupPage, SkillGroupService } from "./skill-groups.js";
import type { Pool } from "pg";
import type { Principal } from "./principal.js";
describe("skill group validation and authorization", () => {
  it("normalizes names and bounds metadata", () => {
    expect(groupMetadata("  Design   team ", " Description ")).toEqual({
      name: "Design team",
      description: "Description",
    });
    for (const n of ["", null, "a".repeat(121)])
      expect(() => groupMetadata(n)).toThrow();
    expect(() => groupMetadata("Sales", "a".repeat(2001))).toThrow();
  });
  it("bounds pages and cursor input", () => {
    expect(groupPage(100)).toEqual({ limit: 100, cursor: null });
    for (const n of [0, 101, 1.5, NaN]) expect(() => groupPage(n)).toThrow();
    expect(() => groupPage(20, {})).toThrow();
  });
  it("denies writes before touching storage for viewers, editors, and service credentials", async () => {
    const pool = {
      query() {
        throw Error("Storage touched");
      },
    } as unknown as Pool;
    const s = new SkillGroupService(pool);
    const servicePrincipal: Principal = {
      kind: "service",
      role: "admin",
      actorId: "svc",
      servicePrincipalId: "svc",
      workspaceId: "w",
      scopes: ["skills:write"],
    };
    await expect(
      s.create({
        principal: servicePrincipal,
        name: "Design",
        idempotencyKey: "test-service-create",
        requestId: "r",
      }),
    ).rejects.toMatchObject({ code: "WORKSPACE_FORBIDDEN" });
    for (const role of ["viewer", "editor"] as const) {
      const p: Principal = {
        kind: "user",
        role,
        actorId: "u",
        userId: "u",
        sessionId: "s",
        workspaceId: "w",
      };
      await expect(
        s.create({
          principal: p,
          name: "Design",
          idempotencyKey: "test-create",
          requestId: "r",
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_FORBIDDEN" });
    }
  });
});
