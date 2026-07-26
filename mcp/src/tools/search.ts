import type { SkillsSearchInput, SkillsSearchOutput } from "@skillplane/mcp-schema";
import { principalForWorkspace } from "../auth.js";
import { executeReadTool, type McpToolRuntime } from "./shared.js";

export function skillsSearch(runtime: McpToolRuntime, input: SkillsSearchInput) {
  return executeReadTool(runtime, "skills_search", input.caller, async (execution) => {
    const workspace = await runtime.services.database.pool.query(
      "SELECT 1 FROM workspaces WHERE id = $1",
      [input.workspaceId],
    );
    if (workspace.rowCount !== 1) {
      throw new Error("WORKSPACE_FORBIDDEN");
    }
    execution.setScope({
      workspaceId: input.workspaceId,
      resourceType: "workspace",
      resourceId: input.workspaceId,
    });
    const principal = await principalForWorkspace(
      runtime.services,
      runtime.identity,
      input.workspaceId,
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
      workspaceId: input.workspaceId,
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
