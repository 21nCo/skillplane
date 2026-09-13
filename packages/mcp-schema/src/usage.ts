import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import { skillSelectorSchema, stableIdSchema } from "./common.js";

export const skillUsageReportInputSchema = z
  .object({
    skill: skillSelectorSchema,
    versionId: stableIdSchema,
    event: z
      .object({
        id: z.uuid(),
        timestamp: z.iso.datetime(),
        type: z.enum([
          "skill_projected",
          "skill_resolved",
          "skill_invoked_observed",
          "skill_action_called",
          "skill_completion_reported",
        ]),
        installationId: z.uuid(),
        agent: z.string().min(1).max(160),
        model: z.string().max(160),
        sessionId: z.string().max(200).nullable(),
        delivery: z.enum(["projection", "live-cli", "live-mcp", "cached-cli"]),
        freshness: z.enum(["verified", "unverified", "pinned"]),
      })
      .strict(),
    caller: callerDeclarationSchema,
  })
  .strict();
export const skillUsageReportOutputSchema = z
  .object({
    requestId: z.string(),
    acceptedId: z.uuid(),
    confidence: z.literal("reported"),
    coverage: z.literal(
      "Client-reported event; disconnected embedded use is unobservable. Success is not inferred.",
    ),
  })
  .strict();
export type SkillUsageReportInput = z.infer<typeof skillUsageReportInputSchema>;
