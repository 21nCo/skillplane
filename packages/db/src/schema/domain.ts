import {
  bigint,
  check,
  customType,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { authfnApiKeys, authfnUsers } from "./authfn.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });
const metadata = (name: string) =>
  jsonb(name).$type<Record<string, unknown>>().notNull().default({});
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("organization"),
    createdByUserId: text("created_by_user_id").references(() => authfnUsers.id, {
      onDelete: "set null",
    }),
    personalOwnerUserId: text("personal_owner_user_id").references(
      () => authfnUsers.id,
      { onDelete: "restrict" },
    ),
    metadata: metadata("metadata"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspaces_workspace_id_unique").on(table.workspaceId),
    uniqueIndex("workspaces_slug_unique").on(table.slug),
    uniqueIndex("workspaces_personal_owner_unique").on(table.personalOwnerUserId),
  ],
);

export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => authfnUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_memberships_workspace_user_unique").on(
      table.workspaceId,
      table.userId,
    ),
    index("workspace_memberships_user_idx").on(table.userId, table.workspaceId),
  ],
);

export const workspaceInvitations = pgTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    emailCiphertext: text("email_ciphertext").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => authfnUsers.id, { onDelete: "restrict" }),
    expiresAt: utcTimestamp("expires_at").notNull(),
    acceptedAt: utcTimestamp("accepted_at"),
    acceptedByUserId: text("accepted_by_user_id").references(() => authfnUsers.id, {
      onDelete: "set null",
    }),
    revokedAt: utcTimestamp("revoked_at"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("workspace_invitations_token_hash_unique").on(table.tokenHash),
    index("workspace_invitations_workspace_email_hash_idx").on(
      table.workspaceId,
      table.emailHash,
    ),
    uniqueIndex("workspace_invitations_active_email_unique")
      .on(table.workspaceId, table.emailHash)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  ],
);

export const servicePrincipals = pgTable(
  "service_principals",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").notNull().default("viewer"),
    scopes: text("scopes").array().notNull().default([]),
    authfnApiKeyId: text("authfn_api_key_id").references(() => authfnApiKeys.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").references(() => authfnUsers.id, {
      onDelete: "set null",
    }),
    delegatedUserId: text("delegated_user_id").references(() => authfnUsers.id, {
      onDelete: "set null",
    }),
    expiresAt: utcTimestamp("expires_at"),
    credentialVersion: integer("credential_version").notNull().default(1),
    lastUsedAt: utcTimestamp("last_used_at"),
    revokedAt: utcTimestamp("revoked_at"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("service_principals_authfn_api_key_unique")
      .on(table.authfnApiKeyId)
      .where(sql`${table.authfnApiKeyId} IS NOT NULL`),
    uniqueIndex("service_principals_workspace_name_unique").on(
      table.workspaceId,
      table.name,
    ),
  ],
);

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    // Global workspace existence is validated by the control-plane service.
    // Regional databases deliberately have no cross-database foreign key.
    workspaceId: text("workspace_id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    tags: text("tags").array().notNull().default([]),
    visibility: text("visibility").notNull().default("private"),
    nextRevision: integer("next_revision").notNull().default(1),
    amendmentPolicy: metadata("amendment_policy"),
    publishedSearchText: text("published_search_text").notNull().default(""),
    contextSearchText: text("context_search_text").notNull().default(""),
    publicSearchDocument: tsvector("public_search_document").generatedAlwaysAs(
      sql`skillplane_skill_search_document_v2(
        name, description, tags, published_search_text, ''
      )`,
    ),
    workspaceSearchDocument: tsvector("workspace_search_document").generatedAlwaysAs(
      sql`skillplane_skill_search_document_v2(
        name, description, tags, published_search_text, context_search_text
      )`,
    ),
    currentPublishedVersionId: text("current_published_version_id"),
    createdByUserId: text("created_by_user_id"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
    archivedAt: utcTimestamp("archived_at"),
  },
  (table) => [
    uniqueIndex("skills_workspace_slug_unique").on(table.workspaceId, table.slug),
    uniqueIndex("skills_workspace_id_id_unique").on(table.workspaceId, table.id),
    index("skills_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
  ],
);

export const skillVersions = pgTable(
  "skill_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    semanticVersion: text("semantic_version"),
    status: text("status").notNull().default("draft"),
    baseVersionId: text("base_version_id"),
    proposedBump: text("proposed_bump"),
    source: text("source").notNull(),
    contentDigest: text("content_digest").notNull(),
    r2ObjectKey: text("r2_object_key").notNull(),
    bundleByteSize: bigint("bundle_byte_size", { mode: "number" }).notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    learningMetadata: jsonb("learning_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    amendmentOperations: jsonb("amendment_operations")
      .$type<readonly Record<string, unknown>[]>()
      .notNull()
      .default([]),
    callerDeclaration: metadata("caller_declaration"),
    policyDecision: metadata("policy_decision"),
    changeSummary: text("change_summary").notNull().default(""),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdByAgent: text("created_by_agent"),
    createdByModel: text("created_by_model"),
    createdForUserId: text("created_for_user_id"),
    publishedAt: utcTimestamp("published_at"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("skill_versions_skill_revision_unique").on(
      table.skillId,
      table.revision,
    ),
    uniqueIndex("skill_versions_skill_semver_unique").on(
      table.skillId,
      table.semanticVersion,
    ),
    uniqueIndex("skill_versions_workspace_id_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("skill_versions_workspace_skill_revision_idx").on(
      table.workspaceId,
      table.skillId,
      table.revision,
    ),
  ],
);

export const skillVersionFiles = pgTable(
  "skill_version_files",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    skillVersionId: text("skill_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    r2ObjectKey: text("r2_object_key").notNull(),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("skill_version_files_version_path_unique").on(
      table.skillVersionId,
      table.path,
    ),
    index("skill_version_files_workspace_version_idx").on(
      table.workspaceId,
      table.skillVersionId,
    ),
  ],
);

export const skillContexts = pgTable(
  "skill_contexts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    contextType: text("context_type")
      .$type<"repository" | "project" | "customer" | "environment" | "custom">()
      .notNull()
      .default("custom"),
    externalReference: text("external_reference"),
    description: text("description").notNull().default(""),
    metadata: metadata("metadata"),
    currentKnowledgeRevisionId: text("current_knowledge_revision_id"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
    archivedAt: utcTimestamp("archived_at"),
  },
  (table) => [
    uniqueIndex("skill_contexts_skill_slug_unique").on(table.skillId, table.slug),
    uniqueIndex("skill_contexts_workspace_id_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("skill_contexts_workspace_skill_idx").on(table.workspaceId, table.skillId),
  ],
);

export const contextKnowledgeRevisions = pgTable(
  "context_knowledge_revisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    contextId: text("context_id")
      .notNull()
      .references(() => skillContexts.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    baseRevisionId: text("base_revision_id"),
    knowledge: text("knowledge").notNull(),
    bodyDigest: text("body_digest").notNull(),
    learningMetadata: jsonb("learning_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdByAgent: text("created_by_agent"),
    createdByModel: text("created_by_model"),
    createdForUserId: text("created_for_user_id"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("context_knowledge_context_revision_unique").on(
      table.contextId,
      table.revision,
    ),
    uniqueIndex("context_knowledge_workspace_id_id_unique").on(
      table.workspaceId,
      table.id,
    ),
    index("context_knowledge_workspace_context_revision_idx").on(
      table.workspaceId,
      table.contextId,
      table.revision,
    ),
  ],
);

export const contextNotes = pgTable(
  "context_notes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    contextId: text("context_id")
      .notNull()
      .references(() => skillContexts.id, { onDelete: "cascade" }),
    noteKey: text("note_key").notNull(),
    title: text("title").notNull(),
    currentRevisionId: text("current_revision_id"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
    archivedAt: utcTimestamp("archived_at"),
  },
  (table) => [
    uniqueIndex("context_notes_context_note_key_unique").on(
      table.contextId,
      table.noteKey,
    ),
    uniqueIndex("context_notes_workspace_id_id_unique").on(table.workspaceId, table.id),
    index("context_notes_workspace_context_idx").on(table.workspaceId, table.contextId),
  ],
);

export const contextNoteRevisions = pgTable(
  "context_note_revisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    noteId: text("note_id")
      .notNull()
      .references(() => contextNotes.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    baseRevisionId: text("base_revision_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    bodyDigest: text("body_digest").notNull(),
    learningMetadata: jsonb("learning_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdByActorType: text("created_by_actor_type").notNull(),
    createdByActorId: text("created_by_actor_id").notNull(),
    createdByAgent: text("created_by_agent"),
    createdByModel: text("created_by_model"),
    createdForUserId: text("created_for_user_id"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("context_note_revisions_note_revision_unique").on(
      table.noteId,
      table.revision,
    ),
    index("context_note_revisions_workspace_note_idx").on(
      table.workspaceId,
      table.noteId,
      table.revision,
    ),
  ],
);

export const amendmentReviews = pgTable(
  "amendment_reviews",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    proposedVersionId: text("proposed_version_id")
      .notNull()
      .references(() => skillVersions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    decisionReason: text("decision_reason"),
    requestedByActorType: text("requested_by_actor_type").notNull(),
    requestedByActorId: text("requested_by_actor_id").notNull(),
    requestedByAgent: text("requested_by_agent"),
    requestedByModel: text("requested_by_model"),
    requestedForUserId: text("requested_for_user_id"),
    policyDecision: metadata("policy_decision"),
    reviewedByActorType: text("reviewed_by_actor_type"),
    reviewedByActorId: text("reviewed_by_actor_id"),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: utcTimestamp("reviewed_at"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("amendment_reviews_proposed_version_unique").on(
      table.proposedVersionId,
    ),
    index("amendment_reviews_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.createdAt,
    ),
    index("amendment_reviews_workspace_skill_created_idx").on(
      table.workspaceId,
      table.skillId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    occurredAt: utcTimestamp("occurred_at").notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    userId: text("user_id"),
    agent: text("agent"),
    model: text("model"),
    requestId: text("request_id").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    contextId: text("context_id"),
    metadata: metadata("metadata"),
    retentionClass: text("retention_class").notNull().default("permanent"),
  },
  (table) => [
    index("audit_events_workspace_time_idx").on(table.workspaceId, table.occurredAt),
    index("audit_events_workspace_resource_idx").on(
      table.workspaceId,
      table.resourceType,
      table.resourceId,
    ),
    index("audit_events_request_idx").on(table.requestId),
    index("audit_events_retention_idx").on(
      table.retentionClass,
      table.occurredAt,
      table.id,
    ),
    index("audit_events_workspace_filters_idx").on(
      table.workspaceId,
      table.action,
      table.outcome,
      table.occurredAt,
      table.id,
    ),
    index("audit_events_public_agent_skill_use_idx")
      .on(table.workspaceId, table.occurredAt, table.id)
      .where(sql`${table.action} = 'skill_retrieve' AND ${table.outcome} = 'success'`),
  ],
);

export const publicStatsCounters = pgTable(
  "public_stats_counters",
  {
    id: text("id").primaryKey(),
    agentSkillUses: numeric("agent_skill_uses").notNull().default("0"),
    totalSkills: numeric("total_skills").notNull().default("0"),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "public_stats_counters_agent_skill_uses_nonnegative",
      sql`${table.agentSkillUses} >= 0`,
    ),
    check(
      "public_stats_counters_total_skills_nonnegative",
      sql`${table.totalSkills} >= 0`,
    ),
  ],
);

export const publicStatsProjectionEvents = pgTable(
  "public_stats_projection_events",
  {
    eventId: text("event_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    appliedAt: utcTimestamp("applied_at").notNull().defaultNow(),
  },
  (table) => [
    index("public_stats_projection_workspace_time_idx").on(
      table.workspaceId,
      table.appliedAt,
    ),
  ],
);

export const analyticsDaily = pgTable(
  "analytics_daily",
  {
    workspaceId: text("workspace_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    skillId: text("skill_id").notNull().default(""),
    contextId: text("context_id").notNull().default(""),
    agent: text("agent").notNull().default(""),
    model: text("model").notNull().default(""),
    retrievalCount: bigint("retrieval_count", { mode: "number" }).notNull().default(0),
    amendmentCount: bigint("amendment_count", { mode: "number" }).notNull().default(0),
    contextWriteCount: bigint("context_write_count", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "analytics_daily_pk",
      columns: [
        table.workspaceId,
        table.day,
        table.skillId,
        table.contextId,
        table.agent,
        table.model,
      ],
    }),
    index("analytics_daily_workspace_day_idx").on(table.workspaceId, table.day),
  ],
);

export const analyticsDailySummary = pgTable(
  "analytics_daily_summary",
  {
    workspaceId: text("workspace_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    skillId: text("skill_id").notNull().default(""),
    eventCount: bigint("event_count", { mode: "number" }).notNull().default(0),
    retrievalCount: bigint("retrieval_count", { mode: "number" }).notNull().default(0),
    amendmentCount: bigint("amendment_count", { mode: "number" }).notNull().default(0),
    approvalCount: bigint("approval_count", { mode: "number" }).notNull().default(0),
    contextWriteCount: bigint("context_write_count", { mode: "number" })
      .notNull()
      .default(0),
    failureCount: bigint("failure_count", { mode: "number" }).notNull().default(0),
    uniquePrincipalCount: bigint("unique_principal_count", { mode: "number" })
      .notNull()
      .default(0),
    uniqueAgentCount: bigint("unique_agent_count", { mode: "number" })
      .notNull()
      .default(0),
    uniqueModelCount: bigint("unique_model_count", { mode: "number" })
      .notNull()
      .default(0),
    latencyP50Ms: doublePrecision("latency_p50_ms"),
    latencyP95Ms: doublePrecision("latency_p95_ms"),
    currentVersionRetrievalCount: bigint("current_version_retrieval_count", {
      mode: "number",
    })
      .notNull()
      .default(0),
    versionedRetrievalCount: bigint("versioned_retrieval_count", {
      mode: "number",
    })
      .notNull()
      .default(0),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "analytics_daily_summary_pk",
      columns: [table.workspaceId, table.day, table.skillId],
    }),
    index("analytics_daily_summary_workspace_day_idx").on(
      table.workspaceId,
      table.day,
      table.skillId,
    ),
  ],
);

export const analyticsDailyDimensions = pgTable(
  "analytics_daily_dimensions",
  {
    workspaceId: text("workspace_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    skillId: text("skill_id").notNull().default(""),
    dimensionType: text("dimension_type").notNull(),
    dimensionValue: text("dimension_value").notNull(),
    eventCount: bigint("event_count", { mode: "number" }).notNull().default(0),
    failureCount: bigint("failure_count", { mode: "number" }).notNull().default(0),
    uniquePrincipalCount: bigint("unique_principal_count", { mode: "number" })
      .notNull()
      .default(0),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "analytics_daily_dimensions_pk",
      columns: [
        table.workspaceId,
        table.day,
        table.skillId,
        table.dimensionType,
        table.dimensionValue,
      ],
    }),
    index("analytics_daily_dimensions_lookup_idx").on(
      table.workspaceId,
      table.dimensionType,
      table.day,
      table.skillId,
      table.eventCount,
    ),
  ],
);

export const analyticsRollupRuns = pgTable(
  "analytics_rollup_runs",
  {
    workspaceId: text("workspace_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    sourceEventCount: bigint("source_event_count", { mode: "number" })
      .notNull()
      .default(0),
    sourceLatestEventAt: utcTimestamp("source_latest_event_at"),
    completedAt: utcTimestamp("completed_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "analytics_rollup_runs_pk",
      columns: [table.workspaceId, table.day],
    }),
    index("analytics_rollup_runs_completed_idx").on(table.completedAt),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    workspaceId: text("workspace_id").notNull(),
    principalKey: text("principal_key").notNull(),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    lockedUntil: utcTimestamp("locked_until").notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "idempotency_records_pk",
      columns: [table.workspaceId, table.principalKey, table.key, table.operation],
    }),
    index("idempotency_records_expiry_idx").on(table.expiresAt),
  ],
);

export const apiRateLimits = pgTable(
  "api_rate_limits",
  {
    bucketHash: text("bucket_hash").notNull(),
    windowStartedAt: utcTimestamp("window_started_at").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    expiresAt: utcTimestamp("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "api_rate_limits_pk",
      columns: [table.bucketHash, table.windowStartedAt],
    }),
    index("api_rate_limits_expiry_idx").on(table.expiresAt),
  ],
);

export const domainSchema = {
  workspaces,
  workspaceMemberships,
  workspaceInvitations,
  servicePrincipals,
  skills,
  skillVersions,
  skillVersionFiles,
  skillContexts,
  contextKnowledgeRevisions,
  contextNotes,
  contextNoteRevisions,
  amendmentReviews,
  auditEvents,
  publicStatsCounters,
  publicStatsProjectionEvents,
  analyticsDaily,
  analyticsDailySummary,
  analyticsDailyDimensions,
  analyticsRollupRuns,
  idempotencyRecords,
  apiRateLimits,
};
