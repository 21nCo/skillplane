import { describe, expect, it } from "vitest";
import {
  normalizeWorkspaceName,
  normalizeWorkspaceSlug,
  personalWorkspaceSlug,
} from "./workspaces.js";

describe("workspaces", () => {
  it("normalizes organization names and slugs deterministically", () => {
    expect(normalizeWorkspaceName("  Acme   Research ")).toBe("Acme Research");
    expect(normalizeWorkspaceSlug(" Acme Research ")).toBe("acme-research");
  });

  it("derives a stable non-empty personal slug", () => {
    expect(personalWorkspaceSlug("user:Example-01")).toBe("personal-user-example-01");
    expect(() => normalizeWorkspaceSlug("!")).toThrow("2 to 63");
  });
});
