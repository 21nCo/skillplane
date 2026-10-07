import {
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  uniqueIndex,
  foreignKey,
  primaryKey,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { skills, skillVersions } from "./domain.js";
const utc = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
export const skillSources = pgTable(
  "skill_sources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    ref: text("ref").notNull(),
    refPolicy: text("ref_policy").notNull(),
    skillPath: text("skill_path"),
    revision: integer("revision").notNull().default(1),
    archivedAt: utc("archived_at"),
    syncToken: text("sync_token"),
    syncExpiresAt: utc("sync_expires_at"),
    creationHash: text("creation_hash").notNull(),
    createdAt: utc("created_at").notNull().defaultNow(),
    updatedAt: utc("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_sources_workspace_id_unique").on(t.workspaceId, t.id),
    check("skill_sources_ref_policy_check", sql`${t.refPolicy} IN ('track','pin')`),
  ],
);
export const skillSourceRuns = pgTable(
  "skill_source_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    commitSha: text("commit_sha").notNull(),
    plan: jsonb("plan").notNull(),
    results: jsonb("results").notNull().default([]),
    failureMessage: text("failure_message"),
    status: text("status").notNull().default("preview"),
    createdAt: utc("created_at").notNull().defaultNow(),
    appliedAt: utc("applied_at"),
  },
  (t) => [
    uniqueIndex("skill_source_runs_workspace_id_unique").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [skillSources.workspaceId, skillSources.id],
    }),
    index("skill_source_runs_recent_idx").on(t.workspaceId, t.sourceId, t.createdAt),
    check(
      "skill_source_runs_status_check",
      sql`${t.status} IN ('preview','partial','complete')`,
    ),
    check("skill_source_runs_commit_sha_check", sql`${t.commitSha} ~ '^[a-f0-9]{40}$'`),
  ],
);
export const skillSourceBindings = pgTable(
  "skill_source_bindings",
  {
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    skillPath: text("skill_path").notNull(),
    skillId: text("skill_id").notNull(),
    lastCommitSha: text("last_commit_sha"),
    lastDigest: text("last_digest"),
    lastVersionId: text("last_version_id"),
    baseVersionId: text("base_version_id"),
    disconnectedAt: utc("disconnected_at"),
    status: text("status").notNull().default("bound"),
    updatedAt: utc("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.skillPath] }),
    uniqueIndex("skill_source_bindings_workspace_skill_unique")
      .on(t.workspaceId, t.skillId)
      .where(sql`${t.disconnectedAt} IS NULL`),
    foreignKey({
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [skillSources.workspaceId, skillSources.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.skillId],
      foreignColumns: [skills.workspaceId, skills.id],
    }),
  ],
);
export const skillVersionGitProvenance = pgTable(
  "skill_version_git_provenance",
  {
    versionId: text("version_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    runId: text("run_id").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    commitSha: text("commit_sha").notNull(),
    skillPath: text("skill_path").notNull(),
    bundleDigest: text("bundle_digest").notNull(),
    importedAt: utc("imported_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("skill_version_git_provenance_run_skill_unique").on(
      t.runId,
      t.skillPath,
    ),
    foreignKey({
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [skillSources.workspaceId, skillSources.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [skillSourceRuns.workspaceId, skillSourceRuns.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.versionId],
      foreignColumns: [skillVersions.workspaceId, skillVersions.id],
    }),
    check(
      "skill_version_git_provenance_commit_sha_check",
      sql`${t.commitSha} ~ '^[a-f0-9]{40}$'`,
    ),
  ],
);
export const gitSourceSchema = {
  skill_sources: skillSources,
  skill_source_runs: skillSourceRuns,
  skill_source_bindings: skillSourceBindings,
  skill_version_git_provenance: skillVersionGitProvenance,
};
