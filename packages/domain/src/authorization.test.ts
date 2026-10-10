import { describe, expect, it } from "vitest";
import {
  actionsForRole,
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
    expect(actionsForRole("viewer")).toEqual([
      "workspace:read",
      "members:read",
      "skills:read",
      "contexts:read",
      "analytics:read",
    ]);
    expect(actionsForRole("editor")).toContain("skills:write");
    expect(actionsForRole("admin")).toContain("members:write");
    expect(actionsForRole("owner")).toEqual(WORKSPACE_ACTIONS);
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
