import { z } from "zod";
import { amendmentPolicyDecisionSchema } from "./amend.js";
import { callerDeclarationSchema } from "./caller.js";
import {
  digestSchema,
  fileDigestSchema,
  limitSchema,
  nullableCursorSchema,
  skillSelectorSchema,
  skillVisibilitySchema,
  slugSchema,
  stableIdSchema,
  timestampSchema,
  versionStateSchema,
  workspaceSelectorSchema,
} from "./common.js";
import { idempotencyKeySchema } from "./context-mutations.js";

const skillNameSchema = z.string().trim().min(1).max(160);
const skillDescriptionSchema = z.string().max(20_000);
const skillTagSchema = z.string().trim().min(1).max(80);
const fileContentSchema = z.string().max(2 * 1024 * 1024);
const base64ContentSchema = fileContentSchema.refine(
  (value) =>
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value),
  "contentBase64 must be canonical base64",
);

export const skillLifecycleRecordSchema = z
  .object({
    id: stableIdSchema,
    workspaceId: stableIdSchema,
    workspaceSlug: slugSchema,
    slug: slugSchema,
    name: skillNameSchema,
    description: skillDescriptionSchema,
    tags: z.array(skillTagSchema).max(30),
    visibility: skillVisibilitySchema,
    currentVersion: z
      .object({
        id: stableIdSchema,
        semanticVersion: z.string().min(1).max(160),
      })
      .strict()
      .nullable(),
    archivedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const skillLifecycleVersionSchema = z
  .object({
    id: stableIdSchema,
    revision: z.number().int().positive(),
    semanticVersion: z.string().min(1).max(160).nullable(),
    state: versionStateSchema,
    source: z.enum(["human", "agent_amendment", "import"]),
    digest: digestSchema,
    baseVersionId: stableIdSchema.nullable(),
    proposedBump: z.enum(["patch", "minor", "major"]).nullable(),
    changeSummary: z.string().max(2_000),
    createdAt: timestampSchema,
    publishedAt: timestampSchema.nullable(),
  })
  .strict();

const skillCreateFileSchema = z
  .object({
    path: z.string().min(1).max(240),
    content: fileContentSchema.optional(),
    contentBase64: base64ContentSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.content === undefined) !== (value.contentBase64 === undefined),
    "Each asset requires exactly one content encoding",
  )
  .refine(
    (value) => !["SKILL.md", "skill.json"].includes(value.path),
    "SKILL.md and skill.json are reserved paths",
  );

export const skillCreateInputSchema = z
  .object({
    workspace: workspaceSelectorSchema,
    slug: slugSchema,
    name: skillNameSchema,
    description: skillDescriptionSchema.default(""),
    tags: z.array(skillTagSchema).max(30).default([]),
    visibility: skillVisibilitySchema.default("private"),
    instructions: z
      .string()
      .min(1)
      .max(2 * 1024 * 1024),
    assets: z.array(skillCreateFileSchema).max(100).default([]),
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.instructions.length +
        value.assets.reduce(
          (total, asset) =>
            total + (asset.content?.length ?? asset.contentBase64?.length ?? 0),
          0,
        ) <=
      8 * 1024 * 1024,
    "The encoded skill file set exceeds 8 MiB",
  )
  .refine(
    (value) =>
      new Set(value.assets.map((asset) => asset.path)).size === value.assets.length,
    "Asset paths must be unique",
  );

export const skillCreateOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skill: skillLifecycleRecordSchema,
    version: skillLifecycleVersionSchema,
  })
  .strict();

export const skillVisibilityUpdateInputSchema = z
  .object({
    skill: skillSelectorSchema,
    visibility: skillVisibilitySchema,
    expectedUpdatedAt: timestampSchema,
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillStateMutationInputSchema = z
  .object({
    skill: skillSelectorSchema,
    expectedUpdatedAt: timestampSchema,
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillLifecycleMutationOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skill: skillLifecycleRecordSchema,
  })
  .strict();

const servicePrincipalScopeSchema = z.enum([
  "skills:read",
  "skills:write",
  "skills:amend",
  "contexts:read",
  "contexts:write",
  "members:read",
  "members:write",
  "analytics:read",
  "audit:read",
]);

export const amendmentPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("review_required") }).strict(),
  z
    .object({
      mode: z.literal("trusted_auto_publish"),
      rules: z
        .array(
          z
            .object({
              credentialId: stableIdSchema,
              requiredScopes: z.array(servicePrincipalScopeSchema).min(1).max(9),
              maxBump: z.enum(["patch", "minor", "major"]),
              allowedContextIds: z.array(stableIdSchema).max(100),
              dailyLimit: z.number().int().min(1).max(10_000).nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(50),
    })
    .strict(),
]);

export const skillAmendmentPolicyGetInputSchema = z
  .object({
    skill: skillSelectorSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillAmendmentPolicyUpdateInputSchema = z
  .object({
    skill: skillSelectorSchema,
    policy: amendmentPolicySchema,
    expectedUpdatedAt: timestampSchema,
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillAmendmentPolicyOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    skillUpdatedAt: timestampSchema,
    policy: amendmentPolicySchema,
  })
  .strict();

export const amendmentReviewStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "superseded",
]);

export const skillCandidateSchema = z
  .object({
    review: z
      .object({
        id: stableIdSchema,
        status: amendmentReviewStatusSchema,
        decisionReason: z.string().max(2_000).nullable(),
        requestedBy: z
          .object({
            actorType: z.enum(["user", "service_principal", "system"]),
            agent: z.string().max(240).nullable(),
            model: z.string().max(240).nullable(),
          })
          .strict(),
        policyDecision: amendmentPolicyDecisionSchema,
        reviewedAt: timestampSchema.nullable(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
      })
      .strict(),
    candidate: skillLifecycleVersionSchema,
  })
  .strict();

export const skillCandidatesListInputSchema = z
  .object({
    skill: skillSelectorSchema,
    status: z
      .enum(["all", "pending", "approved", "rejected", "superseded"])
      .default("all"),
    cursor: nullableCursorSchema,
    limit: limitSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillCandidatesListOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    candidates: z.array(skillCandidateSchema).max(100),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict();

export const skillCandidateDecisionInputSchema = z
  .object({
    skill: skillSelectorSchema,
    reviewId: stableIdSchema,
    expectedUpdatedAt: timestampSchema,
    reason: z.string().trim().min(1).max(2_000),
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillCandidateDecisionOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    result: skillCandidateSchema,
  })
  .strict();

const skillFileTextChangeSchema = z
  .object({
    kind: z.enum(["added", "removed", "unchanged"]),
    value: z.string().max(200_000),
    lineCount: z.number().int().nonnegative(),
  })
  .strict();

export const skillVersionsDiffInputSchema = z
  .object({
    skill: skillSelectorSchema,
    fromVersionId: stableIdSchema,
    toVersionId: stableIdSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillVersionsDiffOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    fromVersionId: stableIdSchema,
    toVersionId: stableIdSchema,
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(240),
            status: z.enum(["added", "removed", "modified", "unchanged"]),
            fromSha256: fileDigestSchema.nullable(),
            toSha256: fileDigestSchema.nullable(),
            mediaType: z.string().min(1).max(160),
            textChanges: z.array(skillFileTextChangeSchema).optional(),
            truncated: z.boolean().optional(),
          })
          .strict(),
      )
      .max(1_000),
  })
  .strict();

export type SkillLifecycleRecord = z.infer<typeof skillLifecycleRecordSchema>;
export type SkillLifecycleVersion = z.infer<typeof skillLifecycleVersionSchema>;
export type SkillCreateInput = z.infer<typeof skillCreateInputSchema>;
export type SkillCreateOutput = z.infer<typeof skillCreateOutputSchema>;
export type SkillVisibilityUpdateInput = z.infer<
  typeof skillVisibilityUpdateInputSchema
>;
export type SkillStateMutationInput = z.infer<typeof skillStateMutationInputSchema>;
export type SkillLifecycleMutationOutput = z.infer<
  typeof skillLifecycleMutationOutputSchema
>;
export type SkillAmendmentPolicyGetInput = z.infer<
  typeof skillAmendmentPolicyGetInputSchema
>;
export type SkillAmendmentPolicyUpdateInput = z.infer<
  typeof skillAmendmentPolicyUpdateInputSchema
>;
export type SkillAmendmentPolicyOutput = z.infer<
  typeof skillAmendmentPolicyOutputSchema
>;
export type SkillCandidate = z.infer<typeof skillCandidateSchema>;
export type SkillCandidatesListInput = z.infer<typeof skillCandidatesListInputSchema>;
export type SkillCandidatesListOutput = z.infer<typeof skillCandidatesListOutputSchema>;
export type SkillCandidateDecisionInput = z.infer<
  typeof skillCandidateDecisionInputSchema
>;
export type SkillCandidateDecisionOutput = z.infer<
  typeof skillCandidateDecisionOutputSchema
>;
export type SkillVersionsDiffInput = z.infer<typeof skillVersionsDiffInputSchema>;
export type SkillVersionsDiffOutput = z.infer<typeof skillVersionsDiffOutputSchema>;
