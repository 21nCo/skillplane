/**
 * Live MCP tool inventory shared by registration checks, conformance, and the
 * production gate. Keep this list identical to `skillplaneMcpDeclaration` in
 * `server.ts`; `tool-catalog.test.ts` fails if they drift.
 */
export const SKILLPLANE_MCP_TOOL_NAMES = [
  "context_archive",
  "context_create",
  "context_get",
  "context_knowledge_history",
  "context_knowledge_update",
  "context_note_upsert",
  "context_notes_list",
  "context_restore",
  "context_update",
  "contexts_list",
  "skill_amend",
  "skill_amendment_policy_get",
  "skill_amendment_policy_update",
  "skill_archive",
  "skill_asset_retrieve",
  "skill_candidate_approve",
  "skill_candidate_reject",
  "skill_candidates_list",
  "skill_composition_candidate_create",
  "skill_create",
  "skill_dependency_upgrade",
  "skill_dependency_upgrades_get",
  "skill_execution_report",
  "skill_resolve",
  "skill_restore",
  "skill_retrieve",
  "skill_usage_report",
  "skill_verification_evidence_add",
  "skill_verification_plan_get",
  "skill_verification_run_complete",
  "skill_verification_run_get",
  "skill_verification_run_start",
  "skill_version_lifecycle_update",
  "skill_versions_diff",
  "skill_versions_list",
  "skill_visibility_update",
  "skills_list",
  "skills_search",
  "workspaces_list",
] as const;

export type SkillplaneMcpToolName = (typeof SKILLPLANE_MCP_TOOL_NAMES)[number];

export const SKILLPLANE_MCP_TOOL_COUNT = SKILLPLANE_MCP_TOOL_NAMES.length;

export function registeredSkillplaneMcpToolNames(
  tools: readonly { readonly name: string }[],
): string[] {
  return tools.map((tool) => tool.name).toSorted();
}

export function assertExactSkillplaneMcpToolInventory(names: readonly string[]): void {
  const received = [...names].toSorted();
  const expected = [...SKILLPLANE_MCP_TOOL_NAMES];
  if (JSON.stringify(received) !== JSON.stringify(expected)) {
    throw new Error(
      `The MCP tool inventory is incomplete: expected ${String(expected.length)} tools [${expected.join(", ")}]; received ${String(received.length)} tools [${received.join(", ")}]`,
    );
  }
}
