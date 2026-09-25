import { describe, expect, it } from "vitest";
import { skillplaneMcpDeclaration } from "./server.js";
import {
  SKILLPLANE_MCP_TOOL_COUNT,
  SKILLPLANE_MCP_TOOL_NAMES,
  assertExactSkillplaneMcpToolInventory,
  registeredSkillplaneMcpToolNames,
} from "./tool-catalog.js";

describe("MCP tool catalog source of truth", () => {
  it("matches live server registration, including composition and verification", () => {
    const registered = registeredSkillplaneMcpToolNames(
      skillplaneMcpDeclaration.registry.definitions(),
    );
    expect(registered).toEqual([...SKILLPLANE_MCP_TOOL_NAMES]);
    expect(SKILLPLANE_MCP_TOOL_COUNT).toBe(39);
    expect(registered).toContain("skill_usage_report");
    expect(registered).toContain("skill_resolve");
    expect(registered).toContain("skill_composition_candidate_create");
    expect(registered).toContain("skill_verification_plan_get");
    expect(() => assertExactSkillplaneMcpToolInventory(registered)).not.toThrow();
  });
});
