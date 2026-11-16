import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const utc = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const backgroundJobs = pgTable(
  "background_jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    kind: text("kind").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    state: text("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: utc("run_after").notNull().defaultNow(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: utc("lease_expires_at"),
    lastError: text("last_error"),
    createdAt: utc("created_at").notNull().defaultNow(),
    updatedAt: utc("updated_at").notNull().defaultNow(),
    completedAt: utc("completed_at"),
  },
  (t) => [
    uniqueIndex("background_jobs_workspace_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("background_jobs_idempotency_unique").on(
      t.workspaceId,
      t.kind,
      t.idempotencyKey,
    ),
    index("background_jobs_due_idx")
      .on(t.runAfter)
      .where(sql`${t.state} IN ('queued', 'failed')`),
    index("background_jobs_lease_idx")
      .on(t.leaseExpiresAt)
      .where(sql`${t.state} = 'running'`),
    index("background_jobs_workspace_failed_idx")
      .on(t.workspaceId, t.updatedAt.desc())
      .where(sql`${t.state} IN ('failed', 'dead')`),
    check(
      "background_jobs_kind_check",
      sql`${t.kind} ~ '^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)+$' AND char_length(${t.kind}) <= 64`,
    ),
    check(
      "background_jobs_idempotency_key_check",
      sql`char_length(${t.idempotencyKey}) BETWEEN 1 AND 200`,
    ),
    check(
      "background_jobs_payload_check",
      sql`jsonb_typeof(${t.payload}) = 'object' AND octet_length(${t.payload}::text) <= 16384`,
    ),
    check(
      "background_jobs_state_check",
      sql`${t.state} IN ('queued', 'running', 'succeeded', 'failed', 'dead')`,
    ),
    check("background_jobs_attempts_check", sql`${t.attempts} >= 0`),
    check("background_jobs_last_error_check", sql`char_length(${t.lastError}) <= 2000`),
    check(
      "background_jobs_lease_check",
      sql`CASE WHEN ${t.state} = 'running'
        THEN ${t.leaseOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL
        ELSE ${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL END`,
    ),
  ],
);

export const backgroundJobSchema = {
  background_jobs: backgroundJobs,
};
