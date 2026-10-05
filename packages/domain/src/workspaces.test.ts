import { describe, expect, it } from "vitest";
import { normalizeWorkspaceName, normalizeWorkspaceSlug } from "./workspaces.js";

describe("workspaces", () => {
  it("normalizes organization names and slugs deterministically", () => {
    expect(normalizeWorkspaceName("  Acme   Research ")).toBe("Acme Research");
    expect(normalizeWorkspaceSlug(" Acme Research ")).toBe("acme-research");
  });

  it("rejects slugs that cannot be normalized", () => {
    expect(() => normalizeWorkspaceSlug("!")).toThrow("2 to 63");
  });
});
