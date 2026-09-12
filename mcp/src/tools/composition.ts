import { type z } from "zod";
import {
  type SkillResolveInput,
  type versionLifecycleInputSchema,
  type compositionCandidateInputSchema,
  type verificationStartInputSchema,
  type verificationEvidenceInputSchema,
  type verificationCompleteInputSchema,
  type verificationRunInputSchema,
  type dependencyUpgradeInputSchema,
  McpToolError,
} from "@skillplane/mcp-schema";
import { registerResourceRoutes } from "@skillplane/api";
import { executeReadTool, executeMutationTool, type McpToolRuntime } from "./shared.js";
import { resolveSkill, resolveVersion } from "./resolve.js";
export function skillResolve(runtime: McpToolRuntime, input: SkillResolveInput) {
  return executeReadTool(
    runtime,
    input.purpose === "verify" ? "skill_verification_plan_get" : "skill_resolve",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: true,
      });
      const version = await resolveVersion(runtime, execution, skill, input.version);
      return {
        output: {
          requestId: execution.requestId,
          plan: await runtime.services.compositionService.resolve(
            version.id,
            skill.principal,
            input.purpose,
          ),
        },
      };
    },
  );
}
export function verificationStart(
  runtime: McpToolRuntime,
  input: z.infer<typeof verificationStartInputSchema>,
) {
  return executeMutationTool(
    runtime,
    "skill_verification_run_start",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
      });
      if (!skill.principal)
        throw new McpToolError("WORKSPACE_FORBIDDEN", "Workspace access is required");
      const version = await resolveVersion(runtime, execution, skill, input.version);
      const result = await runtime.services.verificationService.start({
        ...input,
        versionId: version.id,
        principal: skill.principal,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
      });
      return { output: { requestId: execution.requestId, result } };
    },
  );
}
export function verificationGet(
  runtime: McpToolRuntime,
  input: z.infer<typeof verificationRunInputSchema>,
) {
  return executeReadTool(
    runtime,
    "skill_verification_run_get",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
      });
      if (!skill.principal)
        throw new McpToolError("WORKSPACE_FORBIDDEN", "Workspace access is required");
      const result = await runtime.services.verificationService.get(
        input.runId,
        skill.principal,
      );
      const plan = await runtime.services.compositionService.resolve(
        result.version_id,
        skill.principal,
        "verify",
      );
      if (plan.root.skillId !== skill.id)
        throw new McpToolError("NOT_FOUND", "Verification run was not found");
      return { output: { requestId: execution.requestId, result } };
    },
  );
}
export function verificationEvidence(
  runtime: McpToolRuntime,
  input: z.infer<typeof verificationEvidenceInputSchema>,
) {
  return executeMutationTool(
    runtime,
    "skill_verification_evidence_add",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
      });
      if (!skill.principal)
        throw new McpToolError("WORKSPACE_FORBIDDEN", "Workspace access is required");
      const result = await runtime.services.verificationService.addEvidence({
        ...input,
        skillId: skill.id,
        principal: skill.principal,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
      });
      return { output: { requestId: execution.requestId, result } };
    },
  );
}
export function verificationComplete(
  runtime: McpToolRuntime,
  input: z.infer<typeof verificationCompleteInputSchema>,
) {
  return executeMutationTool(
    runtime,
    "skill_verification_run_complete",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
      });
      if (!skill.principal)
        throw new McpToolError("WORKSPACE_FORBIDDEN", "Workspace access is required");
      const result = await runtime.services.verificationService.complete({
        ...input,
        skillId: skill.id,
        principal: skill.principal,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
      });
      return { output: { requestId: execution.requestId, result } };
    },
  );
}
export function dependencyUpgrade(
  runtime: McpToolRuntime,
  input: z.infer<typeof dependencyUpgradeInputSchema>,
) {
  return executeMutationTool(
    runtime,
    "skill_dependency_upgrade",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:write",
        allowPublic: false,
      });
      if (!skill.principal)
        throw new McpToolError("WORKSPACE_FORBIDDEN", "Workspace access is required");
      const version = await resolveVersion(runtime, execution, skill, input.version, {
        forDependencyUpgrade: true,
      });
      const bundle = await runtime.services.compositionService.upgradeBundle(
        version.id,
        skill.id,
        skill.principal,
      );
      const diff = await runtime.services.compositionService.upgradePreview(
        version.id,
        skill.principal,
        skill.id,
      );
      const candidate = await runtime.services.skillVersionService.createCandidate({
        skillId: skill.id,
        principal: skill.principal,
        baseVersionId: version.id,
        proposedBump: input.proposedBump,
        changeSummary: "Upgrade locked skill dependencies",
        archiveBytes: bundle.bytes,
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
      });
      await registerResourceRoutes(runtime.services, skill.workspaceId, [
        { resourceType: "skill_version", resourceId: candidate.id },
      ]);
      const publicCandidate = { ...candidate, objectKey: undefined };
      return {
        output: {
          requestId: execution.requestId,
          result: { candidate: publicCandidate, diff },
        },
      };
    },
  );
}

export function dependencyUpgradePreview(
  runtime: McpToolRuntime,
  input: SkillResolveInput,
) {
  return executeReadTool(
    runtime,
    "skill_dependency_upgrades_get",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:read",
        allowPublic: false,
      });
      if (!skill.principal)
        throw new McpToolError("WORKSPACE_FORBIDDEN", "Workspace access is required");
      const version = await resolveVersion(runtime, execution, skill, input.version, {
        forDependencyUpgrade: true,
      });
      return {
        output: {
          requestId: execution.requestId,
          result: await runtime.services.compositionService.upgradePreview(
            version.id,
            skill.principal,
          ),
        },
      };
    },
  );
}
export function versionLifecycle(
  runtime: McpToolRuntime,
  input: z.infer<typeof versionLifecycleInputSchema>,
) {
  return executeMutationTool(
    runtime,
    "skill_version_lifecycle_update",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:publish",
        allowPublic: false,
      });
      if (!skill.principal)
        throw new McpToolError("WORKSPACE_FORBIDDEN", "Workspace access is required");
      const version = await resolveVersion(runtime, execution, skill, input.version, {
        allowRevoked: true,
      });
      const result = await runtime.services.versionLifecycleService.set({
        ...input,
        skillId: skill.id,
        versionId: version.id,
        principal: skill.principal,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
      });
      return { output: { requestId: execution.requestId, result } };
    },
  );
}
export function compositionCandidate(
  runtime: McpToolRuntime,
  input: z.infer<typeof compositionCandidateInputSchema>,
) {
  return executeMutationTool(
    runtime,
    "skill_composition_candidate_create",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "skills:write",
        allowPublic: false,
      });
      if (!skill.principal)
        throw new McpToolError("WORKSPACE_FORBIDDEN", "Workspace access is required");
      const version = await resolveVersion(runtime, execution, skill, input.version);
      const stored = await runtime.services.bundleStorage.getCanonicalBundle(
        version.objectKey,
        version.digest,
      );
      const { canonicalizeBundle, canonicalizeBundleFiles } =
        await import("@skillplane/storage");
      const base = await canonicalizeBundle(stored.bytes);
      const files = new Map(base.files);
      files.delete("skill.lock.json");
      if (input.verifierInstructions && input.claimsJson) {
        files.set(
          "verification/VERIFY.md",
          new TextEncoder().encode(input.verifierInstructions),
        );
        files.set(
          "verification/claims.json",
          new TextEncoder().encode(input.claimsJson),
        );
      }
      const verify =
        Boolean(input.verifierInstructions) ||
        (base.skill.formatVersion === 2 && Boolean(base.skill.entrypoints.verify));
      const bundle = await canonicalizeBundleFiles({
        skill: {
          formatVersion: 2,
          name: base.skill.name,
          slug: base.skill.slug,
          description: base.skill.description,
          tags: base.skill.tags,
          dependencies: input.dependencies,
          entrypoints: {
            execute: "SKILL.md",
            ...(verify ? { verify: "verification/VERIFY.md" as const } : {}),
          },
          ...(verify
            ? {
                verification: {
                  claims: "verification/claims.json" as const,
                  blocking:
                    base.skill.formatVersion === 2
                      ? (base.skill.verification?.blocking ?? false)
                      : false,
                },
              }
            : {}),
        },
        files,
      });
      const candidate = await runtime.services.skillVersionService.createCandidate({
        skillId: skill.id,
        principal: skill.principal,
        baseVersionId: version.id,
        proposedBump: input.proposedBump,
        changeSummary: input.changeSummary,
        archiveBytes: bundle.bytes,
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
      });
      await registerResourceRoutes(runtime.services, skill.workspaceId, [
        { resourceType: "skill_version", resourceId: candidate.id },
      ]);
      const result = { ...candidate, objectKey: undefined };
      return { output: { requestId: execution.requestId, result } };
    },
  );
}
