import type { SkillAmendInput, SkillAmendOutput } from "@skillplane/mcp-schema";
import { resolveSkill } from "./resolve.js";
import {
  executeMutationTool,
  mutationAuditContext,
  type McpToolRuntime,
} from "./shared.js";

export function skillAmend(runtime: McpToolRuntime, input: SkillAmendInput) {
  return executeMutationTool(
    runtime,
    "skill_amend",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(
        runtime,
        execution,
        { id: input.skillId },
        {
          action: "skills:amend",
          allowPublic: false,
          includeArchived: true,
        },
      );
      if (!skill.principal) {
        throw new Error("WORKSPACE_FORBIDDEN");
      }
      const amended = await runtime.services.amendmentService.amend({
        skillId: skill.id,
        principal: skill.principal,
        baseVersionId: input.baseVersionId,
        proposedBump: input.proposedBump,
        changes: input.changes,
        learning: input.learning,
        caller: {
          agent: input.caller.agentName,
          model: input.caller.modelName,
          client: input.caller.clientName,
          runId: input.caller.runId,
          sessionId: input.caller.sessionId,
          conversationId: input.caller.conversationId,
          forUserId: runtime.identity.userId,
        },
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
        auditContext: mutationAuditContext(runtime, input.caller),
      });
      execution.setScope({
        resourceType: "skill_version",
        resourceId: amended.candidate.id,
        versionId: amended.candidate.id,
        versionDigest: amended.candidate.digest,
      });
      const output: SkillAmendOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        baseVersionId: input.baseVersionId,
        candidate: {
          id: amended.candidate.id,
          revision: amended.candidate.revision,
          state: amended.autoPublished ? "published" : "candidate",
          semanticVersion: amended.candidate.semanticVersion,
          digest: amended.candidate.digest,
          proposedBump: input.proposedBump,
          createdAt: amended.candidate.createdAt,
          publishedAt: amended.candidate.publishedAt,
        },
        review: {
          id: amended.review.id,
          status: amended.review.status,
        },
        policyDecision: amended.policyDecision,
        autoPublished: amended.autoPublished,
      };
      return { output };
    },
  );
}
