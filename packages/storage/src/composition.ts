import { z } from "zod";

const selector = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const dependencySchema = z
  .object({
    alias: selector,
    workspace: selector,
    skill: selector,
    version: z.string().trim().min(1).max(200),
    scope: z.enum(["execution", "verification", "both"]),
    mode: z.enum(["include", "invoke"]),
    order: z.number().int().min(0).max(1000).optional(),
    required: z.boolean().default(true),
  })
  .strict();
export type SkillDependency = z.infer<typeof dependencySchema>;

export const verificationClaimSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    statement: z.string().trim().min(1).max(4000),
    severity: z.enum(["blocking", "advisory"]),
    scope: z.string().trim().min(1).max(1000),
    requiredEvidence: z.array(z.string().min(1).max(100)).min(1).max(30),
    prohibitedBypasses: z.array(z.string().min(1).max(1000)).max(30),
    rules: z
      .object({
        pass: z.string().min(1).max(4000),
        fail: z.string().min(1).max(4000),
        unknown: z.string().min(1).max(4000),
      })
      .strict(),
    procedure: z
      .string()
      .regex(/^verification\/[a-zA-Z0-9/_-]+\.md$/)
      .max(240)
      .optional(),
  })
  .strict();
export const verificationClaimsSchema = z
  .array(verificationClaimSchema)
  .max(100)
  .superRefine((claims, ctx) => {
    if (new Set(claims.map((c) => c.id)).size !== claims.length)
      ctx.addIssue({ code: "custom", message: "Claim IDs must be unique" });
  });
export type VerificationClaim = z.infer<typeof verificationClaimSchema>;
