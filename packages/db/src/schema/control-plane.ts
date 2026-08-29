import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./domain.js";

const utcTimestamp = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

export const workspacePlacements = pgTable(
  "workspace_placements",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    regionId: text("region_id").notNull(),
    epoch: bigint("epoch", { mode: "number" }).notNull().default(1),
    state: text("state")
      .$type<"active" | "moving" | "tombstoned">()
      .notNull()
      .default("active"),
    destinationRef: text("destination_ref"),
    movingToRegionId: text("moving_to_region_id"),
    previousRegionId: text("previous_region_id"),
    migration: jsonb("migration").$type<Record<string, unknown>>(),
    cacheExpiresAt: utcTimestamp("cache_expires_at"),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("workspace_placements_region_state_idx").on(table.regionId, table.state),
    check("workspace_placements_epoch_positive", sql`${table.epoch} > 0`),
    check(
      "workspace_placements_state_valid",
      sql`${table.state} IN ('active', 'moving', 'tombstoned')`,
    ),
    check(
      "workspace_placements_move_target_consistent",
      sql`(${table.state} = 'moving') = (${table.movingToRegionId} IS NOT NULL)`,
    ),
  ],
);

export const resourceRoutingDirectory = pgTable(
  "resource_routing_directory",
  {
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    state: text("state").$type<"active" | "tombstoned">().notNull().default("active"),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "resource_routing_directory_pk",
      columns: [table.resourceType, table.resourceId],
    }),
    index("resource_routing_workspace_idx").on(table.workspaceId, table.resourceType),
    check(
      "resource_routing_type_valid",
      sql`${table.resourceType} IN ('workspace', 'skill', 'skill_version', 'context', 'context_note')`,
    ),
    check(
      "resource_routing_state_valid",
      sql`${table.state} IN ('active', 'tombstoned')`,
    ),
  ],
);

export const permissionDirectoryRecords = pgTable(
  "permission_directory_records",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    indexes: jsonb("indexes")
      .$type<Record<string, string | readonly string[] | null>>()
      .notNull()
      .default({}),
    expiresAt: utcTimestamp("expires_at"),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [index("permission_directory_expiry_idx").on(table.expiresAt)],
);

export const workspaceRoutingNonces = pgTable(
  "workspace_routing_nonces",
  {
    nonce: text("nonce").primaryKey(),
    expiresAt: utcTimestamp("expires_at").notNull(),
  },
  (table) => [index("workspace_routing_nonces_expiry_idx").on(table.expiresAt)],
);

export const publicSkillProjections = pgTable(
  "public_skill_projections",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workspaceSlug: text("workspace_slug").notNull(),
    skillId: text("skill_id").notNull(),
    skillSlug: text("skill_slug").notNull(),
    versionId: text("version_id").notNull(),
    semanticVersion: text("semantic_version").notNull(),
    digest: text("digest").notNull(),
    objectKey: text("object_key").notNull(),
    document: jsonb("document").$type<Record<string, unknown>>().notNull().default({}),
    searchText: text("search_text").notNull().default(""),
    state: text("state")
      .$type<"published" | "unpublished">()
      .notNull()
      .default("published"),
    publishedAt: utcTimestamp("published_at").notNull().defaultNow(),
    unpublishedAt: utcTimestamp("unpublished_at"),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "public_skill_projections_pk",
      columns: [table.workspaceId, table.skillId, table.versionId],
    }),
    uniqueIndex("public_skill_projection_slug_version_unique").on(
      table.workspaceSlug,
      table.skillSlug,
      table.semanticVersion,
    ),
    uniqueIndex("public_skill_projection_object_key_unique").on(table.objectKey),
    index("public_skill_projection_current_idx").on(
      table.workspaceSlug,
      table.skillSlug,
      table.state,
      table.publishedAt,
    ),
    index("public_skill_projection_search_idx").using(
      "gin",
      sql`to_tsvector('english', ${table.searchText})`,
    ),
    check(
      "public_skill_projection_digest_valid",
      sql`${table.digest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
  ],
);

export const workspaceMigrationRuns = pgTable(
  "workspace_migration_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    sourceRegionId: text("source_region_id").notNull(),
    targetRegionId: text("target_region_id").notNull(),
    sourceEpoch: bigint("source_epoch", { mode: "number" }).notNull(),
    finalEpoch: bigint("final_epoch", { mode: "number" }),
    status: text("status")
      .$type<"running" | "completed" | "rolled_back" | "failed">()
      .notNull(),
    phase: text("phase").notNull(),
    recoveryFence: bigint("recovery_fence", { mode: "number" }).notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: utcTimestamp("started_at").notNull().defaultNow(),
    completedAt: utcTimestamp("completed_at"),
    updatedAt: utcTimestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("workspace_migration_workspace_started_idx").on(
      table.workspaceId,
      table.startedAt,
    ),
    index("workspace_migration_status_idx").on(table.status, table.updatedAt),
    check(
      "workspace_migration_regions_distinct",
      sql`${table.sourceRegionId} <> ${table.targetRegionId}`,
    ),
  ],
);

export const controlPlaneAuditEvents = pgTable(
  "control_plane_audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    occurredAt: utcTimestamp("occurred_at").notNull().defaultNow(),
    eventType: text("event_type").notNull(),
    action: text("action").notNull(),
    outcome: text("outcome").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    userId: text("user_id"),
    requestId: text("request_id").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    channel: text("channel").notNull(),
  },
  (table) => [
    index("control_plane_audit_workspace_time_idx").on(
      table.workspaceId,
      table.occurredAt,
    ),
    index("control_plane_audit_request_idx").on(table.requestId),
  ],
);

export const controlPlaneOutbox = pgTable(
  "control_plane_outbox",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    processedAt: utcTimestamp("processed_at"),
  },
  (table) => [
    uniqueIndex("control_plane_outbox_workspace_sequence_unique").on(
      table.workspaceId,
      table.sequence,
    ),
    index("control_plane_outbox_pending_idx").on(table.processedAt, table.createdAt),
  ],
);

/** Regional outbox; no FK to the globally owned workspaces table. */
export const regionalProjectionOutbox = pgTable(
  "regional_projection_outbox",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    fencingEpoch: bigint("fencing_epoch", { mode: "number" }).notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    claimToken: text("claim_token"),
    claimedAt: utcTimestamp("claimed_at"),
    attempts: bigint("attempts", { mode: "number" }).notNull().default(0),
    lastError: text("last_error"),
    processedAt: utcTimestamp("processed_at"),
  },
  (table) => [
    uniqueIndex("regional_projection_outbox_workspace_sequence_unique").on(
      table.workspaceId,
      table.sequence,
    ),
    index("regional_projection_outbox_pending_idx").on(
      table.processedAt,
      table.claimedAt,
      table.createdAt,
    ),
    check("regional_projection_outbox_epoch_positive", sql`${table.fencingEpoch} > 0`),
  ],
);

export const controlPlaneSchema = {
  workspace_placements: workspacePlacements,
  resource_routing_directory: resourceRoutingDirectory,
  permission_directory_records: permissionDirectoryRecords,
  workspace_routing_nonces: workspaceRoutingNonces,
  public_skill_projections: publicSkillProjections,
  workspace_migration_runs: workspaceMigrationRuns,
  control_plane_audit_events: controlPlaneAuditEvents,
  control_plane_outbox: controlPlaneOutbox,
};

export const regionalInfrastructureSchema = {
  regional_projection_outbox: regionalProjectionOutbox,
};
