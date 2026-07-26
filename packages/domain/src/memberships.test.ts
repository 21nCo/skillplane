import { describe, expect, it } from "vitest";
import {
  assertMembershipChange,
  assertOwnerRemains,
  canManageMembership,
} from "./memberships.js";

describe("memberships", () => {
  it("enforces the member-management hierarchy", () => {
    expect(canManageMembership("admin", "viewer", "editor")).toBe(true);
    expect(canManageMembership("admin", "owner", "viewer")).toBe(false);
    expect(canManageMembership("editor", "viewer", "viewer")).toBe(false);
    expect(() => assertMembershipChange("admin", "owner")).toThrow("cannot manage");
  });

  it("never removes the final owner", () => {
    expect(() => assertOwnerRemains(1, true)).toThrow("final owner");
    expect(() => assertOwnerRemains(2, true)).not.toThrow();
  });
});
