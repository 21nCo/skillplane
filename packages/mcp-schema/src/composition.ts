import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  skillSelectorSchema,
  versionSelectorSchema,
  stableIdSchema,
  digestSchema,
  fileDescriptorSchema,
} from "./common.js";
import { idempotencyKeySchema } from "./context-mutations.js";
export const compositionDependencySchema = z
  .object({
    alias: z.string().min(1).max(120),
    workspace: z.string().min(1).max(120),
    skill: z.string().min(1).max(120),
    version: z.string().min(1).max(200),
    scope: z.enum(["execution", "verification", "both"]),
    mode: z.enum(["include", "invoke"]),
    order: z.number().int().min(0).max(1000).optional(),
    required: z.boolean().default(true),
  })
  .strict();
const node = z
  .object({
    versionId: stableIdSchema,
    workspaceId: stableIdSchema,
    skillId: stableIdSchema,
    workspace: z.string(),
    skill: z.string(),
    semanticVersion: z.string().nullable(),
    digest: digestSchema,
    closureDigest: digestSchema,
    expandedBytes: z.number().int().nonnegative(),
  })
  .strict();
const edge = compositionDependencySchema.extend({
  parent: z.string(),
  child: stableIdSchema,
  ordinal: z.number().int().nonnegative(),
});
const module = z
  .object({
    versionId: stableIdSchema,
    workspace: z.string(),
    skill: z.string(),
    digest: digestSchema,
    instructions: z.string(),
    files: z.array(fileDescriptorSchema),
  })
  .strict();
const claim = z
  .object({
    id: z.string(),
    namespacedId: z.string(),
    originatingVersionId: stableIdSchema,
    statement: z.string(),
    severity: z.enum(["blocking", "advisory"]),
    scope: z.string(),
    requiredEvidence: z.array(z.string()),
    prohibitedBypasses: z.array(z.string()),
    rules: z
      .object({ pass: z.string(), fail: z.string(), unknown: z.string() })
      .strict(),
    procedure: z.string().optional(),
  })
  .strict();
export const compositionPlanSchema = z
  .object({
    root: node,
    closureDigest: digestSchema,
    dag: z
      .object({
        formatVersion: z.literal(1),
        nodes: z.array(node),
        edges: z.array(edge),
      })
      .strict(),
    executionPlan: z
      .object({ modules: z.array(module), invocations: z.array(edge) })
      .strict(),
    verificationPlan: z
      .object({ modules: z.array(module), claims: z.array(claim) })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();
export const skillResolveInputSchema = z
  .object({
    skill: skillSelectorSchema,
    version: versionSelectorSchema,
    purpose: z.enum(["execute", "verify"]).default("execute"),
    caller: callerDeclarationSchema,
  })
  .strict();
export const skillResolveOutputSchema = z
  .object({ requestId: z.string(), plan: compositionPlanSchema })
  .strict();
export const verificationStartFieldsSchema = z
  .object({
    repository: z.string().min(1).max(2000),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    environment: z.string().min(1).max(500),
    executorActorId: z.string().min(1).max(160),
    agent: z.string().min(1).max(160),
    model: z.string().min(1).max(160),
  })
  .strict();
export const verificationStartInputSchema = skillResolveInputSchema
  .omit({ purpose: true })
  .extend({
    ...verificationStartFieldsSchema.shape,
    idempotencyKey: idempotencyKeySchema,
  });
export const evidenceReferenceSchema = z
  .object({
    type: z.string().min(1).max(100),
    uri: z.string().min(1).max(2000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    description: z.string().min(1).max(2000),
    redacted: z.literal(true),
  })
  .strict();
export const verificationResultSchema = z
  .object({
    claimId: z.string().min(1).max(400),
    status: z.enum(["pass", "fail", "unknown"]),
    explanation: z.string().min(1).max(4000),
    evidence: z.array(evidenceReferenceSchema).max(50),
  })
  .strict();
export const verificationRunInputSchema = z
  .object({
    skill: skillSelectorSchema,
    runId: stableIdSchema,
    caller: callerDeclarationSchema,
  })
  .strict();
export const verificationCompleteInputSchema = verificationRunInputSchema.extend({
  idempotencyKey: idempotencyKeySchema,
});
export const verificationEvidenceInputSchema = verificationCompleteInputSchema.extend({
  result: verificationResultSchema,
});
export const compositionMutationOutputSchema = z
  .object({ requestId: z.string(), result: z.record(z.string(), z.unknown()) })
  .strict();
export const dependencyUpgradeInputSchema = skillResolveInputSchema
  .omit({ purpose: true })
  .extend({
    proposedBump: z.enum(["patch", "minor", "major"]).default("minor"),
    idempotencyKey: idempotencyKeySchema,
  });
export type SkillResolveInput = z.infer<typeof skillResolveInputSchema>;

export const versionLifecycleInputSchema = skillResolveInputSchema
  .omit({ purpose: true })
  .extend({
    state: z.enum(["deprecated", "revoked"]),
    reason: z.string().min(1).max(2000),
    idempotencyKey: idempotencyKeySchema,
  });
export const compositionCandidateInputSchema = skillResolveInputSchema
  .omit({ purpose: true })
  .extend({
    dependencies: z.array(compositionDependencySchema).max(32),
    verifierInstructions: z
      .string()
      .min(1)
      .max(1024 * 1024)
      .optional(),
    claimsJson: z
      .string()
      .min(2)
      .max(1024 * 1024)
      .optional(),
    proposedBump: z.enum(["patch", "minor", "major"]),
    changeSummary: z.string().min(1).max(2000),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine(
    (v) => Boolean(v.verifierInstructions) === Boolean(v.claimsJson),
    "Verifier instructions and claims must be supplied together",
  );
