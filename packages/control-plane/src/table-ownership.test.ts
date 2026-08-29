import { describe, expect, it } from "vitest";
import {
  GLOBAL_CONTROL_TABLES,
  REGIONAL_WORKSPACE_TABLES,
  assertDisjointTableOwnership,
} from "./table-ownership.js";

describe("database ownership map", () => {
  it("has no table owned by both global and regional databases", () => {
    expect(() => assertDisjointTableOwnership()).not.toThrow();
    expect(GLOBAL_CONTROL_TABLES).toContain("workspace_placements");
    expect(REGIONAL_WORKSPACE_TABLES).toContain("skills");
    expect(REGIONAL_WORKSPACE_TABLES).not.toContain("workspaces");
  });
});
