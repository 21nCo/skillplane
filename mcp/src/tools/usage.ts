import {
  IdempotencyStore,
  hashIdempotentRequest,
  insertPrincipalAudit,
} from "@skillplane/domain";
import { withDomainTransaction } from "@skillplane/domain";
import type { SkillUsageReportInput } from "@skillplane/mcp-schema";
import { resolveSkill, resolveVersion } from "./resolve.js";
import { principalForWorkspace } from "../auth.js";
import { executeMutationTool, type McpToolRuntime } from "./shared.js";

export function skillUsageReport(
  runtime: McpToolRuntime,
  input: SkillUsageReportInput,
) {
  return executeMutationTool(
    runtime,
    "skill_usage_report",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
      });
      await resolveVersion(runtime, execution, skill, {
        selector: "versionId",
        versionId: input.versionId,
      });
      const principal = await principalForWorkspace(
        runtime.services,
        runtime.identity,
        skill.workspaceId,
        "skills:read",
      );
      if (!principal) throw new Error("WORKSPACE_FORBIDDEN");
      const pool = runtime.services.skillService.pool;
      // Retain event receipts beyond ordinary mutation retries so a long offline
      // queue cannot count an acknowledged event a second time on replay.
      const receipts = new IdempotencyStore(pool, 30_000, 100 * 365 * 86_400_000);
      const claim = await receipts.claim({
        workspaceId: skill.workspaceId,
        principal,
        operation: "skill.usage.report",
        key: input.event.id,
        requestHash: await hashIdempotentRequest({
          skillId: skill.id,
          versionId: input.versionId,
          event: input.event,
        }),
        fencingEpoch: runtime.fencingEpoch,
      });
      if (claim.state !== "replay") {
        try {
          await withDomainTransaction(
            pool,
            execution.requestId,
            async ({ client }) => {
              await insertPrincipalAudit(client, principal, {
                eventType: `usage.${input.event.type}.reported`,
                action: "skills:read",
                requestId: execution.requestId,
                resourceType: "skill_version",
                resourceId: input.versionId,
                skillId: skill.id,
                versionId: input.versionId,
                metadata: {
                  usage: {
                    ...input.event,
                    confidence: "reported",
                    modelTrust: "caller-declared",
                    coverage: "observed-paths-only",
                  },
                },
              });
              await receipts.complete(client, claim.identity, 200, {
                acceptedId: input.event.id,
              });
            },
            { fencingEpoch: runtime.fencingEpoch },
          );
        } catch (error) {
          await receipts.release(claim.identity, runtime.fencingEpoch);
          throw error;
        }
      }
      return {
        output: {
          requestId: execution.requestId,
          acceptedId: input.event.id,
          confidence: "reported" as const,
          coverage:
            "Client-reported event; disconnected embedded use is unobservable. Success is not inferred." as const,
        },
      };
    },
  );
}
