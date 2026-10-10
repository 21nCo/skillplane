import type {
  SkillVersionsListInput,
  SkillVersionsListOutput,
} from "@skillplane/mcp-schema";
import { McpToolError } from "@skillplane/mcp-schema";
import { resolveSkill } from "./resolve.js";
import {
  executeReadTool,
  roleCanReadCandidates,
  type McpToolRuntime,
} from "./shared.js";

interface VersionHistoryRow {
  readonly id: string;
  readonly revision: number;
  readonly semantic_version: string | null;
  readonly status: "draft" | "pending_review" | "published" | "rejected";
  readonly source: "human" | "agent_amendment" | "import";
  readonly content_digest: `sha256:${string}`;
  readonly base_version_id: string | null;
  readonly proposed_bump: "patch" | "minor" | "major" | null;
  readonly change_summary: string;
  readonly learning_summary: string | null;
  readonly created_by_actor_type: "user" | "service_principal" | "system";
  readonly published_at: Date | null;
  readonly created_at: Date;
}

function parseBoundary(value: Readonly<Record<string, unknown>>): {
  readonly revision: number;
  readonly id: string;
} {
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.id !== "string"
  ) {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
  return { revision: value.revision, id: value.id };
}

export function skillVersionsList(
  runtime: McpToolRuntime,
  input: SkillVersionsListInput,
) {
  return executeReadTool(
    runtime,
    "skill_versions_list",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: true,
      });
      const requestedStates = [...new Set(input.states)].sort();
      const canReadCandidates =
        skill.principal !== null &&
        roleCanReadCandidates(skill.principal.role, skill.principal);
      const states = canReadCandidates
        ? requestedStates
        : requestedStates.filter((state) => state === "published");
      const filters = {
        skillId: skill.id,
        states,
        candidateAccess: canReadCandidates,
      };
      const boundary = input.cursor
        ? parseBoundary(
            await runtime.cursors.decode(input.cursor, "skill_versions_list", filters),
          )
        : null;
      if (states.length === 0) {
        const output: SkillVersionsListOutput = {
          requestId: execution.requestId,
          skillId: skill.id,
          versions: [],
          nextCursor: null,
        };
        return { output };
      }
      const result = await runtime.services.database.pool.query<VersionHistoryRow>(
        `SELECT id, revision, semantic_version, status, source,
                  content_digest, base_version_id, proposed_bump,
                  change_summary,
                  NULLIF(learning_metadata->>'summary', '') AS learning_summary,
                  created_by_actor_type, published_at, created_at
             FROM skill_versions
            WHERE skill_id = $1
              AND status = ANY($2::text[])
              AND (
                $3::integer IS NULL
                OR revision < $3::integer
                OR (revision = $3::integer AND id > $4::text)
              )
            ORDER BY revision DESC, id ASC
            LIMIT $5`,
        [
          skill.id,
          states,
          boundary?.revision ?? null,
          boundary?.id ?? null,
          input.limit + 1,
        ],
      );
      const hasNext = result.rows.length > input.limit;
      const page = result.rows.slice(0, input.limit);
      const last = hasNext ? page.at(-1) : undefined;
      const output: SkillVersionsListOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        versions: page.map((version) => ({
          id: version.id,
          revision: version.revision,
          semanticVersion: version.semantic_version,
          state: version.status,
          source: version.source,
          digest: version.content_digest,
          baseVersionId: version.base_version_id,
          proposedBump: version.proposed_bump,
          changeSummary: version.change_summary,
          learningSummary: version.learning_summary,
          authorType: version.created_by_actor_type,
          publishedAt: version.published_at?.toISOString() ?? null,
          createdAt: version.created_at.toISOString(),
        })),
        nextCursor: last
          ? await runtime.cursors.encode("skill_versions_list", filters, {
              revision: last.revision,
              id: last.id,
            })
          : null,
      };
      return { output };
    },
  );
}
