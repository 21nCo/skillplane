import { stableJson } from "@skillplane/storage";
import { z } from "zod";
import { type LocalStore } from "./store.js";
import { RuntimeError } from "./contracts.js";

export const usageEventSchema = z
  .object({
    id: z.uuid(),
    timestamp: z.iso.datetime(),
    type: z.enum([
      "skill_projected",
      "skill_resolved",
      "skill_invoked_observed",
      "skill_action_called",
      "skill_completion_reported",
      "skill_success_verified",
    ]),
    workspace: z.string().min(1),
    skillId: z.string().min(1),
    versionId: z.string().min(1),
    projectionId: z.string().nullable(),
    installationId: z.uuid(),
    agent: z.string().min(1).max(160),
    model: z.string().min(1).max(160).default("unknown"),
    modelTrust: z.literal("caller-declared"),
    sessionId: z.string().max(200).nullable(),
    delivery: z.enum(["projection", "live-cli", "live-mcp", "cached-cli"]),
    freshness: z.enum(["verified", "unverified", "pinned"]),
    confidence: z.enum(["observed", "reported", "verified"]),
    evidence: z.string().max(2000).nullable(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const expected =
      e.type === "skill_completion_reported"
        ? "reported"
        : e.type === "skill_success_verified"
          ? "verified"
          : "observed";
    if (
      e.confidence !== expected ||
      (e.type === "skill_success_verified" && !e.evidence)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid event confidence or verification evidence",
      });
  });
export type UsageEvent = z.infer<typeof usageEventSchema>;
export class UsageQueue {
  constructor(readonly store: LocalStore) {}
  record(event: UsageEvent, independentVerifier = false): void {
    event = usageEventSchema.parse(event);
    if (event.type === "skill_success_verified" && !independentVerifier)
      throw new RuntimeError("INDEPENDENT_VERIFIER_REQUIRED");
    const existing = this.store.db
      .prepare("SELECT payload FROM usage WHERE id=?")
      .get(event.id);
    if (
      existing &&
      stableJson(JSON.parse(String(existing.payload))) !== stableJson(event)
    )
      throw new RuntimeError("USAGE_EVENT_CONFLICT");
    this.store.db
      .prepare("INSERT INTO usage(id,payload) VALUES(?,?) ON CONFLICT(id) DO NOTHING")
      .run(event.id, JSON.stringify(event));
    const stored = this.store.db
      .prepare("SELECT payload FROM usage WHERE id=?")
      .get(event.id);
    if (stableJson(JSON.parse(String(stored?.payload))) !== stableJson(event))
      throw new RuntimeError("USAGE_EVENT_CONFLICT");
  }
  report(): {
    coverage: string;
    uploadEnabled: boolean;
    counts: Record<string, number>;
    pending: number;
    quarantined: number;
  } {
    const rows = this.store.db.prepare("SELECT payload,uploaded FROM usage").all();
    const counts: Record<string, number> = {};
    for (const row of rows) {
      let e: UsageEvent;
      try {
        e = usageEventSchema.parse(JSON.parse(String(row.payload)));
      } catch {
        continue;
      }
      const key = `${e.type}/${e.delivery}/${e.confidence}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return {
      coverage:
        "Observed events only. Embedded fallback invocations without CLI or MCP contact are unobservable; these are not complete usage totals.",
      uploadEnabled: this.store.get("analytics:consent") === true,
      counts,
      pending: rows.filter((r) => r.uploaded === 0).length,
      quarantined: rows.filter((r) => r.uploaded === -1).length,
    };
  }
  async upload(
    send: (events: UsageEvent[]) => Promise<string[]>,
    workspace?: string,
  ): Promise<number> {
    if (this.store.get("analytics:consent") !== true)
      throw new RuntimeError("ANALYTICS_CONSENT_REQUIRED");
    if (!workspace?.startsWith("cloud:"))
      throw new RuntimeError("CLOUD_WORKSPACE_REQUIRED");
    const rows = this.store.db
      .prepare(
        "SELECT id,payload FROM usage WHERE uploaded=0 AND CASE WHEN json_valid(payload) THEN json_extract(payload,'$.workspace')=? ELSE 1 END LIMIT 100",
      )
      .all(workspace);
    let accepted = 0;
    let lastFailure: unknown;
    for (const row of rows) {
      let event: UsageEvent;
      try {
        event = usageEventSchema.parse(JSON.parse(String(row.payload)));
      } catch {
        this.store.db
          .prepare("UPDATE usage SET uploaded=-1 WHERE id=?")
          .run(String(row.id));
        continue;
      }
      if (event.workspace !== workspace) continue;
      try {
        const ids = await send([event]);
        if (ids.some((id) => id !== event.id) || ids.length > 1)
          throw new RuntimeError("ANALYTICS_ACK_INVALID");
        if (ids.includes(event.id)) {
          this.store.db.prepare("UPDATE usage SET uploaded=1 WHERE id=?").run(event.id);
          accepted++;
        }
      } catch (error) {
        if (error instanceof RuntimeError && error.code === "ANALYTICS_ACK_INVALID")
          throw error;
        if (
          error instanceof RuntimeError &&
          [
            "SKILL_NOT_FOUND",
            "SKILL_VERSION_NOT_FOUND",
            "NOT_FOUND",
            "VALIDATION_FAILED",
            "USAGE_SCOPE_INVALID",
            "IDEMPOTENCY_KEY_REUSED",
          ].includes(error.code)
        )
          this.store.db
            .prepare("UPDATE usage SET uploaded=-1 WHERE id=?")
            .run(event.id);
        else lastFailure = error;
      }
    }
    if (!accepted && lastFailure)
      throw lastFailure instanceof Error
        ? lastFailure
        : new RuntimeError("CLOUD_UNAVAILABLE");
    return accepted;
  }
}
