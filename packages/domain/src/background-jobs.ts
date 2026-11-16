import type { Pool, PoolClient } from "pg";
import {
  redactAuditMetadata,
  setCurrentWorkspaceRoutingEpoch,
  WorkspaceMaintenanceFencedError,
} from "@skillplane/observability";
import { DomainError } from "./errors.js";

/**
 * Durable per-cell background jobs. Delivery is at least once: the
 * idempotency key prevents a duplicate enqueue, not a duplicate run, so every
 * handler must be idempotent.
 */
export type BackgroundJobState = "queued" | "running" | "succeeded" | "failed" | "dead";

export interface BackgroundJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: BackgroundJobState;
  readonly attempts: number;
  readonly runAfter: Date;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface EnqueueJobInput {
  readonly workspaceId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly runAfter?: Date;
}

export const DEFAULT_BACKGROUND_JOB_MAX_ATTEMPTS = 8;
export const DEFAULT_BACKGROUND_JOB_LEASE_MS = 5 * 60_000;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 60 * 60_000;
const MAX_PAYLOAD_BYTES = 16_384;
const MAX_ERROR_LENGTH = 2_000;
const KIND_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u;

type Queryable = Pick<Pool | PoolClient, "query">;

interface JobRow {
  id: string;
  workspace_id: string;
  kind: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  state: BackgroundJobState;
  attempts: number;
  run_after: Date;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const JOB_COLUMNS = `id, workspace_id, kind, idempotency_key, payload, state, attempts,
  run_after, last_error, created_at, updated_at, completed_at`;

function toJob(row: JobRow): BackgroundJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    state: row.state,
    attempts: row.attempts,
    runAfter: row.run_after,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function invalid(message: string): DomainError {
  return new DomainError("VALIDATION_FAILED", message, 400);
}

function assertKind(kind: string): void {
  if (kind.length > 64 || !KIND_PATTERN.test(kind)) {
    throw invalid("Background job kind is invalid");
  }
}

/**
 * Validates a job payload. Payloads are stored in clear text and outlive the
 * request, so they carry identifiers only: any field the audit redaction
 * policy would drop (credentials, tokens, emails, prompts) is rejected.
 */
function serializePayload(payload: Readonly<Record<string, unknown>>): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw invalid("Background job payload must be JSON");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalid("Background job payload must be a JSON object");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
    throw invalid("Background job payload is too large");
  }
  if (redactAuditMetadata(parsed as Record<string, unknown>).removedFieldCount > 0) {
    throw invalid("Background job payload must not contain secrets or personal data");
  }
  return serialized;
}

/**
 * Enqueues a job, or returns the existing job when the workspace already has
 * one of this kind with the same idempotency key. Pass the caller's
 * transaction client to make the enqueue atomic with the write that needs it.
 */
export async function enqueueJob(
  database: Queryable,
  input: EnqueueJobInput,
): Promise<{ readonly job: BackgroundJob; readonly created: boolean }> {
  if (!input.workspaceId.trim()) throw invalid("Workspace is required");
  assertKind(input.kind);
  if (input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) {
    throw invalid("Background job idempotency key is invalid");
  }
  if (input.runAfter !== undefined && Number.isNaN(input.runAfter.getTime())) {
    throw invalid("Background job run time is invalid");
  }
  const payload = serializePayload(input.payload);
  const inserted = await database.query<JobRow>(
    `INSERT INTO background_jobs
       (id, workspace_id, kind, idempotency_key, payload, run_after)
     VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6::timestamptz, now()))
     ON CONFLICT (workspace_id, kind, idempotency_key) DO NOTHING
     RETURNING ${JOB_COLUMNS}`,
    [
      `background-job:${crypto.randomUUID()}`,
      input.workspaceId,
      input.kind,
      input.idempotencyKey,
      payload,
      input.runAfter?.toISOString() ?? null,
    ],
  );
  if (inserted.rows[0]) return { job: toJob(inserted.rows[0]), created: true };
  const existing = await database.query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM background_jobs
      WHERE workspace_id = $1 AND kind = $2 AND idempotency_key = $3`,
    [input.workspaceId, input.kind, input.idempotencyKey],
  );
  if (!existing.rows[0]) throw new Error("BACKGROUND_JOB_ENQUEUE_CONFLICT_UNRESOLVED");
  return { job: toJob(existing.rows[0]), created: false };
}

export interface BackgroundJobRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** 1 for the first run; a reclaimed or retried job sees a later attempt. */
  readonly attempt: number;
  /** Aborted when the lease expires; the handler should stop promptly. */
  readonly signal: AbortSignal;
}

export interface BackgroundJobHandler {
  readonly kind: string;
  /** Defaults to 8. */
  readonly maxAttempts?: number;
  /**
   * How long one run may take before it is aborted and counted as failed.
   * Defaults to 5 minutes; the stored lease adds a 30 second grace.
   */
  readonly leaseMs?: number;
  run(job: BackgroundJobRun): Promise<void>;
}

export interface RegisteredBackgroundJobHandler extends BackgroundJobHandler {
  readonly maxAttempts: number;
  readonly leaseMs: number;
}

export interface BackgroundJobRegistry {
  readonly kinds: readonly string[];
  get(kind: string): RegisteredBackgroundJobHandler;
}

/** Builds the handler registry, keyed by kind. */
export function createBackgroundJobRegistry(
  handlers: readonly BackgroundJobHandler[],
): BackgroundJobRegistry {
  const byKind = new Map<string, RegisteredBackgroundJobHandler>();
  for (const handler of handlers) {
    assertKind(handler.kind);
    if (byKind.has(handler.kind)) {
      throw new Error(`BACKGROUND_JOB_HANDLER_DUPLICATE:${handler.kind}`);
    }
    const maxAttempts = handler.maxAttempts ?? DEFAULT_BACKGROUND_JOB_MAX_ATTEMPTS;
    const leaseMs = handler.leaseMs ?? DEFAULT_BACKGROUND_JOB_LEASE_MS;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`BACKGROUND_JOB_MAX_ATTEMPTS_INVALID:${handler.kind}`);
    }
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new Error(`BACKGROUND_JOB_LEASE_INVALID:${handler.kind}`);
    }
    byKind.set(handler.kind, {
      kind: handler.kind,
      maxAttempts,
      leaseMs,
      run: (job) => handler.run(job),
    });
  }
  const kinds = [...byKind.keys()].sort();
  return {
    kinds,
    get(kind) {
      const handler = byKind.get(kind);
      if (!handler) throw new Error(`BACKGROUND_JOB_HANDLER_MISSING:${kind}`);
      return handler;
    },
  };
}

/** A no-op handler for tests only; production registries never include it. */
export const testEchoJobHandler: BackgroundJobHandler = {
  kind: "test.echo",
  run: () => Promise.resolve(),
};

/** Delay before retry number `attempt` (1-based): 30s doubling, capped at 1 hour. */
export function backgroundJobRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** exponent);
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1[redacted]@"],
  [/\bbearer\s+[A-Z0-9._~+/-]+=*/giu, "Bearer [redacted]"],
  [/\b(?:gh[pousr]|github_pat|spk)_[A-Z0-9_]{12,}/giu, "[redacted]"],
  [
    /\b((?:access|refresh|id)[_-]?token|token|secret|password|api[_-]?key)(\s*[:=]\s*)\S+/giu,
    "$1$2[redacted]",
  ],
];

/** Bounds and scrubs a handler error before it is stored and shown to operators. */
export function sanitizeBackgroundJobError(error: unknown): string {
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : "Unknown error";
  let message = raw;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    message = message.replace(pattern, replacement);
  }
  return message.slice(0, MAX_ERROR_LENGTH);
}

export interface ClaimedBackgroundJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attempt: number;
  readonly leaseOwner: string;
  readonly leaseMs: number;
}

export type BackgroundJobClaim =
  | { readonly type: "claimed"; readonly job: ClaimedBackgroundJob }
  | { readonly type: "dead"; readonly jobId: string; readonly kind: string }
  | { readonly type: "fenced"; readonly jobId: string }
  | { readonly type: "empty" };

const LEASE_EXPIRED_ERROR = "Lease expired before the job finished";
// The stored lease outlasts the handler's own timeout, so a live drainer gives
// up on a run before another drainer can reclaim it.
const LEASE_GRACE_MS = 30_000;

async function inTransaction<T>(
  database: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Claims the next due job of a registered kind: a queued or retrying job whose
 * run time has come, or a running job whose lease expired. The row lock with
 * SKIP LOCKED keeps concurrent drainers off the same job, and the per-claim
 * lease owner token keeps a stale drainer from finishing a reclaimed job.
 * Workspaces fenced for a regional migration are skipped.
 */
export async function claimBackgroundJob(input: {
  readonly database: Pool;
  readonly registry: BackgroundJobRegistry;
  readonly workerId: string;
  readonly exclude?: readonly string[];
}): Promise<BackgroundJobClaim> {
  if (input.registry.kinds.length === 0) return { type: "empty" };
  const leaseOwner = `${input.workerId}:${crypto.randomUUID()}`;
  let candidateId: string | undefined;
  try {
    return await inTransaction(input.database, async (client) => {
      const candidate = await client.query<{
        id: string;
        workspace_id: string;
        kind: string;
        state: BackgroundJobState;
        attempts: number;
      }>(
        `SELECT job.id, job.workspace_id, job.kind, job.state, job.attempts
           FROM background_jobs AS job
          WHERE job.kind = ANY($1::text[])
            AND NOT (job.id = ANY($2::text[]))
            AND (
              (job.state IN ('queued', 'failed') AND job.run_after <= now())
              OR (job.state = 'running' AND job.lease_expires_at <= now())
            )
            AND NOT EXISTS (
              SELECT 1 FROM regional_workspace_migration_fences AS fence
               WHERE fence.workspace_id = job.workspace_id AND fence.source_epoch > 0
            )
          ORDER BY CASE WHEN job.state = 'running' THEN job.lease_expires_at
                        ELSE job.run_after END, job.id
          LIMIT 1
          FOR UPDATE OF job SKIP LOCKED`,
        [input.registry.kinds, input.exclude ?? []],
      );
      const row = candidate.rows[0];
      if (!row) return { type: "empty" } as const;
      candidateId = row.id;
      try {
        await setCurrentWorkspaceRoutingEpoch(client, row.workspace_id);
      } catch (error) {
        if (error instanceof WorkspaceMaintenanceFencedError) {
          return { type: "fenced", jobId: row.id } as const;
        }
        throw error;
      }
      const handler = input.registry.get(row.kind);
      const reclaimed = row.state === "running";
      if (reclaimed && row.attempts >= handler.maxAttempts) {
        await client.query(
          `UPDATE background_jobs
              SET state = 'dead', lease_owner = NULL, lease_expires_at = NULL,
                  last_error = $2, completed_at = now(), updated_at = now()
            WHERE id = $1`,
          [row.id, LEASE_EXPIRED_ERROR],
        );
        return { type: "dead", jobId: row.id, kind: row.kind } as const;
      }
      const claimed = await client.query<{
        attempts: number;
        payload: Record<string, unknown>;
      }>(
        `UPDATE background_jobs
            SET state = 'running', attempts = attempts + 1, lease_owner = $2,
                lease_expires_at = now() + $3::double precision * interval '1 millisecond',
                last_error = CASE WHEN $4::boolean THEN $5 ELSE last_error END,
                updated_at = now()
          WHERE id = $1
          RETURNING attempts, payload`,
        [
          row.id,
          leaseOwner,
          handler.leaseMs + LEASE_GRACE_MS,
          reclaimed,
          LEASE_EXPIRED_ERROR,
        ],
      );
      const updated = claimed.rows[0];
      if (!updated) throw new Error("BACKGROUND_JOB_CLAIM_LOST");
      return {
        type: "claimed",
        job: {
          id: row.id,
          workspaceId: row.workspace_id,
          kind: row.kind,
          payload: updated.payload,
          attempt: updated.attempts,
          leaseOwner,
          leaseMs: handler.leaseMs,
        },
      } as const;
    });
  } catch (error) {
    // The fence can land between the candidate scan and the claim write.
    if (isFencedWrite(error) && candidateId !== undefined) {
      return { type: "fenced", jobId: candidateId };
    }
    throw error;
  }
}

function isFencedWrite(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "55000"
  );
}

/**
 * Records the outcome of a claimed run. Returns "lost" when the lease was lost
 * (reclaimed after expiry, or the workspace was fenced for migration); the
 * job then stays with its current owner and runs again later.
 */
export async function completeBackgroundJob(input: {
  readonly database: Pool;
  readonly job: ClaimedBackgroundJob;
  readonly maxAttempts: number;
  readonly error?: unknown;
}): Promise<"succeeded" | "failed" | "dead" | "lost"> {
  const outcome =
    input.error === undefined
      ? "succeeded"
      : input.job.attempt >= input.maxAttempts
        ? "dead"
        : "failed";
  const lastError =
    input.error === undefined ? null : sanitizeBackgroundJobError(input.error);
  try {
    return await inTransaction(input.database, async (client) => {
      await setCurrentWorkspaceRoutingEpoch(client, input.job.workspaceId);
      const result = await client.query(
        `UPDATE background_jobs
            SET state = $3::text, lease_owner = NULL, lease_expires_at = NULL,
                last_error = $4,
                run_after = CASE WHEN $3::text = 'failed'
                  THEN now() + $5::double precision * interval '1 millisecond'
                  ELSE run_after END,
                completed_at = CASE WHEN $3::text IN ('succeeded', 'dead')
                  THEN now() ELSE NULL END,
                updated_at = now()
          WHERE id = $1 AND state = 'running' AND lease_owner = $2`,
        [
          input.job.id,
          input.job.leaseOwner,
          outcome,
          lastError,
          backgroundJobRetryDelayMs(input.job.attempt),
        ],
      );
      return result.rowCount === 1 ? outcome : "lost";
    });
  } catch (error) {
    if (error instanceof WorkspaceMaintenanceFencedError || isFencedWrite(error)) {
      return "lost";
    }
    throw error;
  }
}

class BackgroundJobTimeoutError extends Error {
  constructor() {
    super("Job exceeded its lease");
    this.name = "BackgroundJobTimeoutError";
  }
}

async function runWithLease(
  handler: BackgroundJobHandler,
  job: ClaimedBackgroundJob,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new BackgroundJobTimeoutError();
      reject(error);
      controller.abort(error);
    }, job.leaseMs);
  });
  try {
    await Promise.race([
      handler.run({
        id: job.id,
        workspaceId: job.workspaceId,
        kind: job.kind,
        payload: job.payload,
        attempt: job.attempt,
        signal: controller.signal,
      }),
      timeout,
    ]);
    // A handler that returns once aborted still ran out of lease.
    return controller.signal.aborted ? controller.signal.reason : undefined;
  } catch (error) {
    return error ?? new Error("Job failed");
  } finally {
    clearTimeout(timer);
  }
}

export interface BackgroundJobEvent {
  readonly type: "succeeded" | "failed" | "dead" | "lost" | "fenced";
  readonly jobId: string;
  readonly kind?: string;
  readonly attempt?: number;
}

export interface BackgroundJobDrainResult {
  readonly succeeded: number;
  readonly failed: number;
  readonly dead: number;
  readonly lost: number;
}

/**
 * Runs due jobs one at a time until none are due, `limit` jobs have run, or
 * the time budget is spent. The budget bounds when new jobs start; a job that
 * is already running may finish later, bounded by its lease.
 */
export async function drainBackgroundJobs(input: {
  readonly database: Pool;
  readonly registry: BackgroundJobRegistry;
  readonly workerId: string;
  readonly maxDurationMs: number;
  readonly limit?: number;
  readonly clock?: () => number;
  readonly onEvent?: (event: BackgroundJobEvent) => void;
}): Promise<BackgroundJobDrainResult> {
  if (!Number.isFinite(input.maxDurationMs) || input.maxDurationMs <= 0) {
    throw new Error("BACKGROUND_JOB_BUDGET_INVALID");
  }
  const clock = input.clock ?? (() => performance.now());
  const deadline = clock() + input.maxDurationMs;
  const limit = input.limit ?? 1_000;
  const counts = { succeeded: 0, failed: 0, dead: 0, lost: 0 };
  const exclude: string[] = [];
  let started = 0;
  while (started < limit && clock() < deadline) {
    const claim = await claimBackgroundJob({
      database: input.database,
      registry: input.registry,
      workerId: input.workerId,
      exclude,
    });
    if (claim.type === "empty") break;
    if (claim.type === "fenced") {
      exclude.push(claim.jobId);
      input.onEvent?.({ type: "fenced", jobId: claim.jobId });
      continue;
    }
    started += 1;
    if (claim.type === "dead") {
      counts.dead += 1;
      input.onEvent?.({ type: "dead", jobId: claim.jobId, kind: claim.kind });
      continue;
    }
    const handler = input.registry.get(claim.job.kind);
    const error = await runWithLease(handler, claim.job);
    const outcome = await completeBackgroundJob({
      database: input.database,
      job: claim.job,
      maxAttempts: handler.maxAttempts,
      ...(error === undefined ? {} : { error }),
    });
    counts[outcome] += 1;
    // A lost or retried job must not run twice in one tick.
    exclude.push(claim.job.id);
    input.onEvent?.({
      type: outcome,
      jobId: claim.job.id,
      kind: claim.job.kind,
      attempt: claim.job.attempt,
    });
  }
  return counts;
}

export interface FailedBackgroundJob {
  readonly id: string;
  readonly kind: string;
  readonly state: "failed" | "dead";
  readonly attempts: number;
  readonly lastError: string | null;
  readonly runAfter: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Operator view of a workspace's failed (retrying) and dead jobs, newest
 * first. Payloads are never returned.
 */
export async function listFailedBackgroundJobs(
  database: Queryable,
  input: { readonly workspaceId: string; readonly limit?: number },
): Promise<readonly FailedBackgroundJob[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw invalid("Limit must be between 1 and 500");
  }
  const result = await database.query<{
    id: string;
    kind: string;
    state: "failed" | "dead";
    attempts: number;
    last_error: string | null;
    run_after: Date;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, kind, state, attempts, last_error, run_after, created_at, updated_at
       FROM background_jobs
      WHERE workspace_id = $1 AND state IN ('failed', 'dead')
      ORDER BY updated_at DESC, id
      LIMIT $2`,
    [input.workspaceId, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    lastError: row.last_error,
    runAfter: row.run_after,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
