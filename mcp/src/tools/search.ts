import type { SkillsSearchInput, SkillsSearchOutput } from "@skillplane/mcp-schema";
import { principalForWorkspace } from "../auth.js";
import { executeReadTool, reportedKind, type McpToolRuntime } from "./shared.js";

export function skillsSearch(runtime: McpToolRuntime, input: SkillsSearchInput) {
  return executeReadTool(runtime, "skills_search", input.caller, async (execution) => {
    const selector = input.workspace;
    const byId = "id" in selector;
    const workspace = await runtime.services.controlDatabase.pool.query<{
      readonly id: string;
    }>(`SELECT id FROM workspaces WHERE ${byId ? "id" : "slug"} = $1 LIMIT 1`, [
      byId ? selector.id : selector.slug,
    ]);
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) {
      throw new Error("WORKSPACE_FORBIDDEN");
    }
    execution.setScope({
      workspaceId,
      resourceType: "workspace",
      resourceId: workspaceId,
    });
    const principal = await principalForWorkspace(
      runtime.services,
      runtime.identity,
      workspaceId,
      "skills:read",
      { allowPublicWithoutMembership: true },
    );
    const visibility = principal
      ? input.visibility
      : input.visibility.filter((value) => value === "public");
    if (visibility.length === 0) {
      const output: SkillsSearchOutput = {
        requestId: execution.requestId,
        skills: [],
        nextCursor: null,
      };
      return { output };
    }
    const page = await runtime.services.skillSearchService.search({
      query: input.query,
      workspaceId,
      tags: input.tags,
      visibility,
      archive: "active",
      limit: input.limit,
      cursor: input.cursor,
      principal,
      now: runtime.now(),
    });
    const output: SkillsSearchOutput = {
      requestId: execution.requestId,
      skills: page.skills.map((skill) => ({
        id: skill.id,
        workspaceId: skill.workspaceId,
        workspaceSlug: skill.workspaceSlug,
        slug: skill.slug,
        name: skill.name,
        summary: skill.description,
        tags: [...skill.tags],
        visibility: skill.visibility,
        ...reportedKind(skill.kind),
        currentVersion: {
          id: skill.currentVersionId,
          semanticVersion: skill.semanticVersion,
          digest: skill.digest,
        },
      })),
      nextCursor: page.nextCursor,
    };
    return { output };
  });
}
