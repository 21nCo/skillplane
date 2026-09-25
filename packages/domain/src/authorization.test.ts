import { describe, expect, it } from "vitest";
import {
  authorize,
  canPerform,
  type Principal,
  WORKSPACE_ACTIONS,
} from "./index.js";

function user(role: "viewer" | "editor" | "admin" | "owner"): Principal {
  return {
    kind: "user",
    actorId: `user:${role}`,
    userId: `user:${role}`,
    sessionId: "session:test",
    workspaceId: "workspace:test",
    role,
  };
}

describe("workspace authorization matrix", () => {
  it("grants monotonically broader role capabilities", () => {
    const viewer = user("viewer");
    expect(canPerform(viewer, "workspace:read")).toBe(true);
    expect(canPerform(viewer, "members:read")).toBe(true);
    expect(canPerform(viewer, "skills:read")).toBe(true);
    expect(canPerform(viewer, "contexts:read")).toBe(true);
    expect(canPerform(viewer, "analytics:read")).toBe(true);
    expect(canPerform(viewer, "skills:write")).toBe(false);
    expect(canPerform(user("editor"), "skills:write")).toBe(true);
    expect(canPerform(user("admin"), "members:write")).toBe(true);
    for (const action of WORKSPACE_ACTIONS) {
      expect(canPerform(user("owner"), action)).toBe(true);
    }
  });

  it("prevents non-owner workspace deletion", () => {
    for (const role of ["viewer", "editor", "admin"] as const) {
      expect(canPerform(user(role), "workspace:delete")).toBe(false);
      expect(() => authorize(user(role), "workspace:delete")).toThrowError(
        "not allowed",
      );
    }
    expect(canPerform(user("owner"), "workspace:delete")).toBe(true);
  });

  it("maps service principals to explicit scopes only", () => {
    const principal: Principal = {
      kind: "service",
      actorId: "service:ci",
      servicePrincipalId: "service:ci",
      workspaceId: "workspace:test",
      role: "editor",
      scopes: ["skills:read", "contexts:write"],
    };
    expect(canPerform(principal, "skills:read")).toBe(true);
    expect(canPerform(principal, "contexts:write")).toBe(true);
    expect(canPerform(principal, "workspace:update")).toBe(false);
  });
});
