import { describe, expect, it } from "vitest";
import { requiredScopesForRequest } from "./auth.js";
const scopes = (name: string) =>
  requiredScopesForRequest(
    new Request("https://example.test/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: {} },
      }),
    }),
  );
describe("composition token scopes", () => {
  it.each([
    "skill_execution_report",
    "skill_composition_candidate_create",
    "skill_dependency_upgrade",
    "skill_verification_run_start",
    "skill_verification_evidence_add",
    "skill_verification_run_complete",
  ])("requires read and write for %s", async (name) => {
    expect(await scopes(name)).toEqual(["skills:read", "skills:write"]);
  });
  it.each([
    "skill_resolve",
    "skill_verification_plan_get",
    "skill_verification_run_get",
    "skill_dependency_upgrades_get",
  ])("requires read for %s", async (name) => {
    expect(await scopes(name)).toEqual(["skills:read"]);
  });
  it("requires publication authority for revocation", async () => {
    expect(await scopes("skill_version_lifecycle_update")).toEqual(["skills:publish"]);
  });
});
