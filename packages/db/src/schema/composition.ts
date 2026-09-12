import {
  bigint,
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  primaryKey,
  uniqueIndex,
  foreignKey,
  index,
} from "drizzle-orm/pg-core";
import { skillVersions } from "./domain.js";
const utc = (name: string) => timestamp(name, { mode: "date", withTimezone: true });
export const skillVersionCompositions = pgTable(
  "skill_version_compositions",
  {
    workspaceId: text("workspace_id").notNull(),
    versionId: text("version_id").primaryKey(),
    formatVersion: integer("format_version").notNull(),
    dependencyClosureDigest: text("dependency_closure_digest").notNull(),
    dependencyLock: jsonb("dependency_lock").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.versionId],
      foreignColumns: [skillVersions.workspaceId, skillVersions.id],
    }),
  ],
);
export const skillVersionDependencies = pgTable(
  "skill_version_dependencies",
  {
    workspaceId: text("workspace_id").notNull(),
    rootVersionId: text("root_version_id").notNull(),
    parentVersionId: text("parent_version_id").notNull(),
    alias: text("alias").notNull(),
    ordinal: integer("ordinal").notNull(),
    childVersionId: text("child_version_id").notNull(),
    edge: jsonb("edge").notNull(),
    node: jsonb("node").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.rootVersionId, t.parentVersionId, t.alias] }),
    uniqueIndex("skill_version_dependencies_ordinal_unique").on(
      t.rootVersionId,
      t.parentVersionId,
      t.ordinal,
    ),
    foreignKey({
      columns: [t.workspaceId, t.rootVersionId],
      foreignColumns: [skillVersions.workspaceId, skillVersions.id],
    }),
    index("skill_version_dependencies_child_idx").on(t.childVersionId),
  ],
);
export const skillVersionLifecycle = pgTable(
  "skill_version_lifecycle",
  {
    workspaceId: text("workspace_id").notNull(),
    versionId: text("version_id").primaryKey(),
    deprecatedAt: utc("deprecated_at"),
    revokedAt: utc("revoked_at"),
    reason: text("reason").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.versionId],
      foreignColumns: [skillVersions.workspaceId, skillVersions.id],
    }),
  ],
);
export const publicSkillVersionLifecycle = pgTable("public_skill_version_lifecycle", {
  workspaceId: text("workspace_id").notNull(),
  versionId: text("version_id").primaryKey(),
  deprecatedAt: utc("deprecated_at"),
  revokedAt: utc("revoked_at"),
  withdrawnSequence: bigint("withdrawn_sequence", { mode: "number" }),
  reason: text("reason").notNull(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
});
export const skillVerificationRuns = pgTable(
  "skill_verification_runs",
  {
    workspaceId: text("workspace_id").notNull(),
    id: text("id").primaryKey(),
    versionId: text("version_id").notNull(),
    closureDigest: text("closure_digest").notNull(),
    repository: text("repository").notNull(),
    commitSha: text("commit_sha").notNull(),
    environment: text("environment").notNull(),
    verifierActorId: text("verifier_actor_id").notNull(),
    verifierActorType: text("verifier_actor_type").notNull(),
    executorActorId: text("executor_actor_id").notNull(),
    agent: text("agent").notNull(),
    model: text("model").notNull(),
    status: text("status").notNull().default("running"),
    plan: jsonb("plan").notNull(),
    evidenceManifestDigest: text("evidence_manifest_digest"),
    startedAt: utc("started_at").notNull().defaultNow(),
    completedAt: utc("completed_at"),
    expiresAt: utc("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("skill_verification_runs_workspace_id_unique").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.versionId],
      foreignColumns: [skillVersions.workspaceId, skillVersions.id],
    }),
  ],
);
export const skillVerificationClaimResults = pgTable(
  "skill_verification_claim_results",
  {
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    namespacedClaimId: text("namespaced_claim_id").notNull(),
    originatingVersionId: text("originating_version_id").notNull(),
    status: text("status").notNull(),
    explanation: text("explanation").notNull(),
    evidence: jsonb("evidence").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.namespacedClaimId] }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [skillVerificationRuns.workspaceId, skillVerificationRuns.id],
    }),
  ],
);
