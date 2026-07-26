import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  digestSchema,
  fileDigestSchema,
  stableIdSchema,
  timestampSchema,
} from "./common.js";

const mutationTextSchema = z.string().max(2 * 1024 * 1024);
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);

const addOperationSchema = z
  .object({
    operation: z.literal("add"),
    path: z.string().min(1).max(240),
    expectedSha256: z.null(),
    content: mutationTextSchema.optional(),
    contentBase64: mutationTextSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.content === undefined) !== (value.contentBase64 === undefined),
    {
      message: "Add operations require exactly one content encoding",
    },
  );

const replaceOperationSchema = z
  .object({
    operation: z.literal("replace"),
    path: z.string().min(1).max(240),
    expectedSha256: fileDigestSchema,
    content: mutationTextSchema.optional(),
    contentBase64: mutationTextSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.content === undefined) !== (value.contentBase64 === undefined),
    {
      message: "Replace operations require exactly one content encoding",
    },
  );

const deleteOperationSchema = z
  .object({
    operation: z.literal("delete"),
    path: z.string().min(1).max(240),
    expectedSha256: fileDigestSchema,
  })
  .strict();

export const amendmentFileOperationSchema = z.union([
  addOperationSchema,
  replaceOperationSchema,
  deleteOperationSchema,
]);

const learningEvidenceSchema = z
  .object({
    kind: z.string().trim().min(1).max(80),
    reference: z.string().trim().min(1).max(2_000),
    description: z.string().trim().min(1).max(2_000),
  })
  .strict();

const learningValidationSchema = z
  .object({
    kind: z.string().trim().min(1).max(80),
    status: z.enum(["passed", "failed", "not_run"]),
    description: z.string().trim().min(1).max(2_000),
  })
  .strict();

const learningExternalReferenceSchema = z
  .object({
    label: z.string().trim().min(1).max(160),
    url: z.url().max(2_000),
  })
  .strict();

export const amendmentLearningSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    observation: z.string().trim().min(1).max(10_000),
    rationale: z.string().trim().min(1).max(10_000),
    confidence: z.enum(["low", "medium", "high"]),
    evidence: z.array(learningEvidenceSchema).max(50).default([]),
    evidenceUnavailableReason: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .nullable()
      .default(null),
    validation: z.array(learningValidationSchema).max(50).default([]),
    validationNotRunReason: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .nullable()
      .default(null),
    sourceContextId: stableIdSchema.nullable().default(null),
    tags: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    externalReferences: z.array(learningExternalReferenceSchema).max(20).default([]),
    extra: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const skillAmendInputSchema = z
  .object({
    skillId: stableIdSchema,
    baseVersionId: stableIdSchema,
    idempotencyKey: idempotencyKeySchema,
    proposedBump: z.enum(["patch", "minor", "major"]).default("patch"),
    changes: z.array(amendmentFileOperationSchema).min(1).max(100),
    learning: amendmentLearningSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const amendmentPolicyDecisionSchema = z
  .object({
    outcome: z.enum(["review_required", "auto_publish"]),
    reason: z.enum([
      "policy_requires_review",
      "human_principal",
      "credential_not_trusted",
      "scope_requirement_not_met",
      "bump_exceeds_limit",
      "context_not_allowed",
      "daily_limit_reached",
      "trusted_rule_matched",
    ]),
    matchedRule: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const skillAmendOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    baseVersionId: stableIdSchema,
    candidate: z
      .object({
        id: stableIdSchema,
        revision: z.number().int().positive(),
        state: z.enum(["candidate", "published"]),
        semanticVersion: z.string().max(160).nullable(),
        digest: digestSchema,
        proposedBump: z.enum(["patch", "minor", "major"]),
        createdAt: timestampSchema,
        publishedAt: timestampSchema.nullable(),
      })
      .strict(),
    review: z
      .object({
        id: stableIdSchema,
        status: z.enum(["pending", "approved", "rejected", "superseded"]),
      })
      .strict(),
    policyDecision: amendmentPolicyDecisionSchema,
    autoPublished: z.boolean(),
  })
  .strict();

export type SkillAmendInput = z.infer<typeof skillAmendInputSchema>;
export type SkillAmendOutput = z.infer<typeof skillAmendOutputSchema>;
