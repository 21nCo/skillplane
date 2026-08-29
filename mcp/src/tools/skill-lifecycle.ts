import type {
  SkillCreateInput,
  SkillCreateOutput,
  SkillCandidate,
  SkillCandidateDecisionInput,
  SkillCandidateDecisionOutput,
  SkillCandidatesListInput,
  SkillCandidatesListOutput,
  SkillAmendmentPolicyGetInput,
  SkillAmendmentPolicyOutput,
  SkillAmendmentPolicyUpdateInput,
  SkillLifecycleMutationOutput,
  SkillLifecycleRecord,
  SkillLifecycleVersion,
  SkillStateMutationInput,
  SkillVersionsDiffInput,
  SkillVersionsDiffOutput,
  SkillVisibilityUpdateInput,
} from "@skillplane/mcp-schema";
import { amendmentPolicyDecisionSchema, McpToolError } from "@skillplane/mcp-schema";
import type {
  AmendmentReviewDetail,
  Principal,
  SkillRecord,
  SkillVersionRecord,
} from "@skillplane/domain";
import { canonicalizeBundleFiles } from "@skillplane/storage";
import { principalForWorkspace } from "../auth.js";
import { resolveSkill, type ResolvedSkill } from "./resolve.js";
import {
  executeMutationTool,
  executeReadTool,
  mutationAuditContext,
  roleCanReadCandidates,
  type McpToolRuntime,
  type ToolExecution,
} from "./shared.js";

interface WorkspaceRow {
  readonly id: string;
  readonly slug: string;
}

interface CandidateRow {
  readonly review_id: string;
  readonly review_status: SkillCandidate["review"]["status"];
  readonly decision_reason: string | null;
  readonly policy_decision: SkillCandidate["review"]["policyDecision"];
  readonly requested_by_actor_type: SkillCandidate["review"]["requestedBy"]["actorType"];
  readonly requested_by_agent: string | null;
  readonly requested_by_model: string | null;
  readonly reviewed_at: Date | null;
  readonly review_created_at: Date;
  readonly review_updated_at: Date;
  readonly id: string;
  readonly revision: number;
  readonly semantic_version: string | null;
  readonly status: SkillLifecycleVersion["state"];
  readonly source: SkillLifecycleVersion["source"];
  readonly content_digest: `sha256:${string}`;
  readonly base_version_id: string | null;
  readonly proposed_bump: SkillLifecycleVersion["proposedBump"];
  readonly change_summary: string;
  readonly version_created_at: Date;
  readonly published_at: Date | null;
}

function principal(value: Principal | null): Principal {
  if (!value) throw new Error("WORKSPACE_FORBIDDEN");
  return value;
}

function lifecycleSkill(
  skill: SkillRecord | ResolvedSkill,
  workspaceSlug: string,
): SkillLifecycleRecord {
  const currentPublishedVersionId = skill.currentPublishedVersionId;
  const currentSemanticVersion = skill.currentSemanticVersion;
  if ((currentPublishedVersionId === null) !== (currentSemanticVersion === null)) {
    throw new McpToolError(
      "INTERNAL_ERROR",
      "The skill lifecycle record is inconsistent",
      { status: 500, retryable: true },
    );
  }
  return {
    id: skill.id,
    workspaceId: skill.workspaceId,
    workspaceSlug,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    visibility: skill.visibility,
    currentVersion:
      currentPublishedVersionId && currentSemanticVersion
        ? { id: currentPublishedVersionId, semanticVersion: currentSemanticVersion }
        : null,
    archivedAt: skill.archivedAt,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  };
}

function lifecycleVersion(version: SkillVersionRecord): SkillLifecycleVersion {
  return {
    id: version.id,
    revision: version.revision,
    semanticVersion: version.semanticVersion,
    state: version.status,
    source: version.source,
    digest: version.digest,
    baseVersionId: version.baseVersionId,
    proposedBump: version.proposedBump,
    changeSummary: version.changeSummary,
    createdAt: version.createdAt,
    publishedAt: version.publishedAt,
  };
}

function listedCandidate(row: CandidateRow): SkillCandidate {
  return {
    review: {
      id: row.review_id,
      status: row.review_status,
      decisionReason: row.decision_reason,
      requestedBy: {
        actorType: row.requested_by_actor_type,
        agent: row.requested_by_agent,
        model: row.requested_by_model,
      },
      policyDecision: amendmentPolicyDecisionSchema.parse(row.policy_decision),
      reviewedAt: row.reviewed_at?.toISOString() ?? null,
      createdAt: row.review_created_at.toISOString(),
      updatedAt: row.review_updated_at.toISOString(),
    },
    candidate: {
      id: row.id,
      revision: row.revision,
      semanticVersion: row.semantic_version,
      state: row.status,
      source: row.source,
      digest: row.content_digest,
      baseVersionId: row.base_version_id,
      proposedBump: row.proposed_bump,
      changeSummary: row.change_summary,
      createdAt: row.version_created_at.toISOString(),
      publishedAt: row.published_at?.toISOString() ?? null,
    },
  };
}

function decidedCandidate(detail: AmendmentReviewDetail): SkillCandidate {
  return {
    review: {
      id: detail.review.id,
      status: detail.review.status,
      decisionReason: detail.review.decisionReason,
      requestedBy: {
        actorType: detail.review.requestedByActorType,
        agent: detail.review.requestedByAgent,
        model: detail.review.requestedByModel,
      },
      policyDecision: amendmentPolicyDecisionSchema.parse(detail.review.policyDecision),
      reviewedAt: detail.review.reviewedAt,
      createdAt: detail.review.createdAt,
      updatedAt: detail.review.updatedAt,
    },
    candidate: lifecycleVersion(detail.candidate),
  };
}

function outputPolicy(
  policy: Awaited<
    ReturnType<McpToolRuntime["services"]["amendmentPolicyService"]["get"]>
  >,
): SkillAmendmentPolicyOutput["policy"] {
  if (policy.mode === "review_required") return { mode: "review_required" };
  return {
    mode: "trusted_auto_publish",
    rules: policy.rules.map((rule) => ({
      credentialId: rule.credentialId,
      requiredScopes: [...rule.requiredScopes],
      maxBump: rule.maxBump,
      allowedContextIds: [...rule.allowedContextIds],
      dailyLimit: rule.dailyLimit,
    })),
  };
}

async function resolveWorkspaceForWrite(
  runtime: McpToolRuntime,
  execution: ToolExecution,
  selector: SkillCreateInput["workspace"],
): Promise<{ readonly workspace: WorkspaceRow; readonly principal: Principal }> {
  const byId = "id" in selector;
  const result = await runtime.services.controlDatabase.pool.query<WorkspaceRow>(
    `SELECT id, slug
       FROM workspaces
      WHERE ${byId ? "id = $1" : "slug = $1"}
      LIMIT 1`,
    [byId ? selector.id : selector.slug],
  );
  const workspace = result.rows[0];
  if (!workspace) throw new Error("WORKSPACE_FORBIDDEN");
  execution.setScope({
    workspaceId: workspace.id,
    resourceType: "workspace",
    resourceId: workspace.id,
  });
  return {
    workspace,
    principal: principal(
      await principalForWorkspace(
        runtime.services,
        runtime.identity,
        workspace.id,
        "skills:write",
      ),
    ),
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function skillCreate(runtime: McpToolRuntime, input: SkillCreateInput) {
  return executeMutationTool(
    runtime,
    "skill_create",
    input.caller,
    async (execution) => {
      const resolved = await resolveWorkspaceForWrite(
        runtime,
        execution,
        input.workspace,
      );
      const files = new Map<string, Uint8Array>([
        ["SKILL.md", new TextEncoder().encode(input.instructions)],
      ]);
      for (const asset of input.assets) {
        files.set(
          asset.path,
          asset.content !== undefined
            ? new TextEncoder().encode(asset.content)
            : decodeBase64(asset.contentBase64 ?? ""),
        );
      }
      const canonical = await canonicalizeBundleFiles({
        skill: {
          formatVersion: 1,
          name: input.name,
          slug: input.slug,
          description: input.description,
          tags: input.tags,
          entrypoint: "SKILL.md",
        },
        files,
      });
      const created = await runtime.services.skillService.create({
        workspaceId: resolved.workspace.id,
        principal: resolved.principal,
        archiveBytes: canonical.bytes,
        visibility: input.visibility,
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
        auditContext: mutationAuditContext(runtime, input.caller),
      });
      execution.setScope({
        resourceType: "skill",
        resourceId: created.skill.id,
        skillId: created.skill.id,
        versionId: created.version.id,
        versionDigest: created.version.digest,
      });
      const output: SkillCreateOutput = {
        requestId: execution.requestId,
        skill: lifecycleSkill(created.skill, resolved.workspace.slug),
        version: lifecycleVersion(created.version),
      };
      return { output };
    },
  );
}

export function skillVisibilityUpdate(
  runtime: McpToolRuntime,
  input: SkillVisibilityUpdateInput,
) {
  return executeMutationTool(
    runtime,
    "skill_visibility_update",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:write",
        allowPublic: false,
        includeArchived: true,
      });
      const updated = await runtime.services.skillService.setVisibility({
        skillId: skill.id,
        principal: principal(skill.principal),
        visibility: input.visibility,
        expectedUpdatedAt: input.expectedUpdatedAt,
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
        auditContext: mutationAuditContext(runtime, input.caller),
      });
      const output: SkillLifecycleMutationOutput = {
        requestId: execution.requestId,
        skill: lifecycleSkill(updated, skill.workspaceSlug),
      };
      return { output };
    },
  );
}

function skillStateMutation(
  runtime: McpToolRuntime,
  input: SkillStateMutationInput,
  archived: boolean,
) {
  const tool = archived ? "skill_archive" : "skill_restore";
  return executeMutationTool(runtime, tool, input.caller, async (execution) => {
    const skill = await resolveSkill(runtime, execution, input.skill, {
      action: "skills:write",
      allowPublic: false,
      includeArchived: true,
    });
    const updated = await runtime.services.skillService.setArchived({
      skillId: skill.id,
      principal: principal(skill.principal),
      archived,
      expectedUpdatedAt: input.expectedUpdatedAt,
      idempotencyKey: input.idempotencyKey,
      requestId: execution.requestId,
      fencingEpoch: runtime.fencingEpoch,
      auditContext: mutationAuditContext(runtime, input.caller),
    });
    const output: SkillLifecycleMutationOutput = {
      requestId: execution.requestId,
      skill: lifecycleSkill(updated, skill.workspaceSlug),
    };
    return { output };
  });
}

export function skillArchive(runtime: McpToolRuntime, input: SkillStateMutationInput) {
  return skillStateMutation(runtime, input, true);
}

export function skillRestore(runtime: McpToolRuntime, input: SkillStateMutationInput) {
  return skillStateMutation(runtime, input, false);
}

function candidateBoundary(value: Readonly<Record<string, unknown>>): {
  readonly createdAt: string;
  readonly id: string;
} {
  if (
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.id !== "string" ||
    !value.id
  ) {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
  return { createdAt: value.createdAt, id: value.id };
}

export function skillCandidatesList(
  runtime: McpToolRuntime,
  input: SkillCandidatesListInput,
) {
  return executeReadTool(
    runtime,
    "skill_candidates_list",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
        includeArchived: true,
      });
      const skillPrincipal = principal(skill.principal);
      if (!roleCanReadCandidates(skillPrincipal.role, skillPrincipal)) {
        throw new McpToolError(
          "WORKSPACE_FORBIDDEN",
          "The principal cannot read skill candidates",
          { status: 403 },
        );
      }
      const filters = {
        skillId: skill.id,
        status: input.status,
        actorId: runtime.identity.actorId,
        credentialId: runtime.identity.credentialId,
      };
      const boundary = input.cursor
        ? candidateBoundary(
            await runtime.cursors.decode(
              input.cursor,
              "skill_candidates_list",
              filters,
            ),
          )
        : null;
      const result = await runtime.services.database.pool.query<CandidateRow>(
        `SELECT review.id AS review_id, review.status AS review_status,
                review.decision_reason, review.policy_decision,
                review.requested_by_actor_type, review.requested_by_agent,
                review.requested_by_model, review.reviewed_at,
                review.created_at AS review_created_at,
                review.updated_at AS review_updated_at,
                version.id, version.revision, version.semantic_version,
                version.status, version.source, version.content_digest,
                version.base_version_id, version.proposed_bump,
                version.change_summary, version.created_at AS version_created_at,
                version.published_at
           FROM amendment_reviews review
           JOIN skill_versions version
             ON version.id = review.proposed_version_id
            AND version.workspace_id = review.workspace_id
          WHERE review.workspace_id = $1 AND review.skill_id = $2
            AND ($3::text = 'all' OR review.status = $3::text)
            AND (
              $4::timestamptz IS NULL
              OR review.created_at < $4::timestamptz
              OR (review.created_at = $4::timestamptz AND review.id > $5::text)
            )
          ORDER BY review.created_at DESC, review.id ASC
          LIMIT $6`,
        [
          skill.workspaceId,
          skill.id,
          input.status,
          boundary?.createdAt ?? null,
          boundary?.id ?? null,
          input.limit + 1,
        ],
      );
      const hasNext = result.rows.length > input.limit;
      const candidates = result.rows.slice(0, input.limit).map(listedCandidate);
      const last = hasNext ? candidates.at(-1) : undefined;
      const output: SkillCandidatesListOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        candidates,
        nextCursor: last
          ? await runtime.cursors.encode("skill_candidates_list", filters, {
              createdAt: last.review.createdAt,
              id: last.review.id,
            })
          : null,
      };
      return { output };
    },
  );
}

function skillCandidateDecision(
  runtime: McpToolRuntime,
  input: SkillCandidateDecisionInput,
  decision: "approve" | "reject",
) {
  const tool = `skill_candidate_${decision}`;
  return executeMutationTool(runtime, tool, input.caller, async (execution) => {
    const skill = await resolveSkill(runtime, execution, input.skill, {
      action: "skills:publish",
      allowPublic: false,
    });
    const detail = await runtime.services.amendmentReviewService[decision]({
      skillId: skill.id,
      reviewId: input.reviewId,
      principal: principal(skill.principal),
      reason: input.reason,
      expectedUpdatedAt: input.expectedUpdatedAt,
      idempotencyKey: input.idempotencyKey,
      requestId: execution.requestId,
      fencingEpoch: runtime.fencingEpoch,
      auditContext: mutationAuditContext(runtime, input.caller),
    });
    execution.setScope({
      resourceType: "skill_version",
      resourceId: detail.candidate.id,
      versionId: detail.candidate.id,
      versionDigest: detail.candidate.digest,
    });
    const output: SkillCandidateDecisionOutput = {
      requestId: execution.requestId,
      skillId: skill.id,
      result: decidedCandidate(detail),
    };
    return { output };
  });
}

export function skillCandidateApprove(
  runtime: McpToolRuntime,
  input: SkillCandidateDecisionInput,
) {
  return skillCandidateDecision(runtime, input, "approve");
}

export function skillCandidateReject(
  runtime: McpToolRuntime,
  input: SkillCandidateDecisionInput,
) {
  return skillCandidateDecision(runtime, input, "reject");
}

export function skillAmendmentPolicyGet(
  runtime: McpToolRuntime,
  input: SkillAmendmentPolicyGetInput,
) {
  return executeReadTool(
    runtime,
    "skill_amendment_policy_get",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
        includeArchived: true,
      });
      const policy = await runtime.services.amendmentPolicyService.get({
        skillId: skill.id,
        principal: principal(skill.principal),
      });
      const output: SkillAmendmentPolicyOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        skillUpdatedAt: skill.updatedAt,
        policy: outputPolicy(policy),
      };
      return { output };
    },
  );
}

export function skillAmendmentPolicyUpdate(
  runtime: McpToolRuntime,
  input: SkillAmendmentPolicyUpdateInput,
) {
  return executeMutationTool(
    runtime,
    "skill_amendment_policy_update",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:publish",
        allowPublic: false,
      });
      const skillPrincipal = principal(skill.principal);
      if (skillPrincipal.kind !== "user" || skillPrincipal.role !== "owner") {
        throw new McpToolError(
          "WORKSPACE_FORBIDDEN",
          "Only a workspace owner can update amendment policy through MCP",
          { status: 403 },
        );
      }
      const policy = await runtime.services.amendmentPolicyService.update({
        skillId: skill.id,
        principal: skillPrincipal,
        policy: input.policy,
        expectedUpdatedAt: input.expectedUpdatedAt,
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        auditContext: mutationAuditContext(runtime, input.caller),
      });
      const updated = await runtime.services.skillService.get({
        skillId: skill.id,
        principal: skillPrincipal,
        allowArchived: true,
      });
      const output: SkillAmendmentPolicyOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        skillUpdatedAt: updated.updatedAt,
        policy: outputPolicy(policy),
      };
      return { output };
    },
  );
}

export function skillVersionsDiff(
  runtime: McpToolRuntime,
  input: SkillVersionsDiffInput,
) {
  return executeReadTool(
    runtime,
    "skill_versions_diff",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
        includeArchived: true,
      });
      const diff = await runtime.services.skillVersionService.diff({
        skillId: skill.id,
        fromVersionId: input.fromVersionId,
        toVersionId: input.toVersionId,
        principal: principal(skill.principal),
      });
      const output: SkillVersionsDiffOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        fromVersionId: diff.fromVersionId,
        toVersionId: diff.toVersionId,
        files: diff.files.map(({ textChanges, ...file }) => ({
          ...file,
          ...(textChanges
            ? { textChanges: textChanges.map((change) => ({ ...change })) }
            : {}),
        })),
      };
      return { output };
    },
  );
}
