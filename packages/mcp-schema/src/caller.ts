import { z } from "zod";
import { callerTrustSchema, declaredText } from "./common.js";

export const callerDeclarationSchema = z
  .object({
    agentId: declaredText("Agent ID", 160),
    agentName: declaredText("Agent name", 120),
    modelProvider: declaredText("Model provider", 120),
    modelName: declaredText("Model name", 160),
    modelVersion: declaredText("Model version", 120),
    clientName: declaredText("Client name", 160),
    clientVersion: declaredText("Client version", 120),
    runId: declaredText("Run ID", 200),
    sessionId: declaredText("Session ID", 200),
    conversationId: declaredText("Conversation ID", 200),
  })
  .strict();

export const callerAuditSchema = callerDeclarationSchema.extend({
  trust: callerTrustSchema,
});

export type CallerDeclaration = z.infer<typeof callerDeclarationSchema>;
export type CallerAudit = z.infer<typeof callerAuditSchema>;

export function callerAudit(caller: CallerDeclaration): CallerAudit {
  return { ...caller, trust: "caller-declared" };
}
