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
    model: z.string().max(160).default("unknown"),
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
  }
  report(): {
    coverage: string;
    uploadEnabled: boolean;
    counts: Record<string, number>;
    pending: number;
  } {
    const rows = this.store.db.prepare("SELECT payload,uploaded FROM usage").all();
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const e = usageEventSchema.parse(JSON.parse(String(row.payload)));
      const key = `${e.type}/${e.delivery}/${e.confidence}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return {
      coverage:
        "Observed events only. Embedded fallback invocations without CLI or MCP contact are unobservable; these are not complete usage totals.",
      uploadEnabled: this.store.get("analytics:consent") === true,
      counts,
      pending: rows.filter((r) => r.uploaded === 0).length,
    };
  }
  async upload(
    send: (events: UsageEvent[]) => Promise<string[]>,
    workspace?: string,
  ): Promise<number> {
    if (this.store.get("analytics:consent") !== true)
      throw new RuntimeError("ANALYTICS_CONSENT_REQUIRED");
    const events = this.store.db
      .prepare(
        "SELECT payload FROM usage WHERE uploaded=0 AND (? IS NULL OR json_extract(payload,'$.workspace')=?) LIMIT 100",
      )
      .all(workspace ?? null, workspace ?? null)
      .map((r) => usageEventSchema.parse(JSON.parse(String(r.payload))));
    if (!events.length) return 0;
    const ids = await send(events);
    const sent = new Set(events.map((e) => e.id));
    if (ids.some((id) => !sent.has(id)))
      throw new RuntimeError("ANALYTICS_ACK_INVALID");
    this.store.transaction(() => {
      for (const id of ids)
        this.store.db.prepare("UPDATE usage SET uploaded=1 WHERE id=?").run(id);
    });
    return ids.length;
  }
}
