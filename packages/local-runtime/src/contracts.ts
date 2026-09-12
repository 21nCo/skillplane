import { z } from "zod";
import type { CanonicalBundle } from "@skillplane/storage";
import type {
  SkillCreateInput,
  SkillAmendInput,
  CallerDeclaration,
} from "@skillplane/mcp-schema";
export const safeName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const endpointSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}, "Endpoint must be HTTPS (or loopback HTTP) and contain no credentials, query, or fragment");
export const workspaceRefSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local"), id: z.uuid() }).strict(),
  z
    .object({
      provider: z.literal("cloud"),
      profile: safeName,
      endpoint: endpointSchema,
      id: z.string().min(1).max(160),
    })
    .strict(),
]);
export type WorkspaceRef = z.infer<typeof workspaceRefSchema>;
export function workspaceKey(ref: WorkspaceRef): string {
  const parsed = workspaceRefSchema.parse(ref);
  return parsed.provider === "local"
    ? `local:${parsed.id}`
    : `cloud:${encodeURIComponent(parsed.endpoint)}:${parsed.profile}:${encodeURIComponent(parsed.id)}`;
}
export const policySchema = z
  .object({
    mode: z.enum(["resilient", "strict-live", "pinned"]).default("resilient"),
    version: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("latest") }).strict(),
        z
          .object({
            kind: z.literal("compatible"),
            major: z.number().int().nonnegative(),
          })
          .strict(),
        z
          .object({ kind: z.literal("pinned"), id: z.string().min(1).max(160) })
          .strict(),
      ])
      .default({ kind: "latest" }),
  })
  .strict()
  .refine(
    (p) => p.mode !== "pinned" || p.version.kind === "pinned",
    "Pinned mode requires an exact version ID",
  );
export type Policy = z.infer<typeof policySchema>;
export const targetSchema = z
  .object({
    adapter: z.enum(["claude", "codex", "generic"]),
    skills: z.array(safeName).max(1000).optional(),
    directory: z.string().min(1).optional(),
    scope: z.enum(["project", "user"]).default("project"),
    policy: policySchema.default({ mode: "resilient", version: { kind: "latest" } }),
  })
  .strict()
  .refine(
    (t) => t.adapter !== "generic" || Boolean(t.directory),
    "Generic export requires an explicit directory",
  );
export type Target = z.infer<typeof targetSchema>;
export const projectSchema = z
  .object({
    formatVersion: z.literal(1),
    primary: workspaceRefSchema,
    mounts: z
      .array(
        z
          .object({ workspace: workspaceRefSchema, namespace: safeName.optional() })
          .strict(),
      )
      .max(50)
      .default([]),
    aliases: z.record(z.string(), safeName).default({}),
    collisions: z.enum(["error", "precedence"]).default("error"),
    targets: z.array(targetSchema).max(20).default([]),
  })
  .strict();
export type ProjectContext = z.infer<typeof projectSchema>;
export interface VersionInfo {
  id: string;
  semanticVersion: string | null;
  digest: string;
  state: "draft" | "pending_review" | "published" | "rejected";
  createdAt: string;
}
export interface SkillInfo {
  id: string;
  slug: string;
  name: string;
  description: string;
}
export interface Snapshot {
  workspace: WorkspaceRef;
  skill: SkillInfo;
  version: VersionInfo;
  bundle: CanonicalBundle;
}
export type CreateRequest = Omit<SkillCreateInput, "workspace" | "caller">;
export type AmendRequest = Omit<SkillAmendInput, "caller">;
export interface WorkspaceProvider {
  readonly workspace: WorkspaceRef;
  list(): Promise<SkillInfo[]>;
  versions(skillId: string): Promise<VersionInfo[]>;
  retrieve(skillId: string, versionId?: string): Promise<Snapshot>;
  create(request: CreateRequest): Promise<{
    skillId: string;
    versionId: string;
  }>;
  amend(request: AmendRequest): Promise<{
    skillId: string;
    versionId: string;
  }>;
  candidates(skillId: string): Promise<unknown>;
  decide(
    skillId: string,
    reviewId: string,
    expectedUpdatedAt: string,
    approve: boolean,
    reason: string,
    key: string,
  ): Promise<unknown>;
}
export function declaredCaller(
  agent = "unknown",
  sessionId = crypto.randomUUID(),
): CallerDeclaration {
  return {
    agentId: agent,
    agentName: agent,
    modelProvider: "unknown",
    modelName: "unknown",
    modelVersion: "unknown",
    clientName: "skillplane-cli",
    clientVersion: "0.1.0",
    runId: sessionId,
    sessionId,
    conversationId: sessionId,
  };
}
export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}
export function selectVersion(versions: VersionInfo[], policy: Policy): VersionInfo {
  const rule = policy.version;
  const found = versions
    .filter(
      (v) =>
        v.state === "published" &&
        (rule.kind === "latest" ||
          (rule.kind === "pinned"
            ? v.id === rule.id
            : v.semanticVersion?.split(".")[0] === String(rule.major))),
    )
    .sort((a, b) => {
      const av = (a.semanticVersion ?? "0.0.0").split(".").map(Number);
      const bv = (b.semanticVersion ?? "0.0.0").split(".").map(Number);
      return (
        requireValue(bv[0]) - requireValue(av[0]) ||
        requireValue(bv[1]) - requireValue(av[1]) ||
        requireValue(bv[2]) - requireValue(av[2]) ||
        b.createdAt.localeCompare(a.createdAt)
      );
    })[0];
  if (!found) throw new RuntimeError("VERSION_UNAVAILABLE");
  return found;
}
export function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new RuntimeError("REQUIRED_VALUE_MISSING");
  return value;
}
