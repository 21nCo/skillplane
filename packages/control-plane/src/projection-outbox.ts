import { z } from "zod";
import type { WorkspacePlacementDirectory } from "./placement.js";
import {
  publishGlobalProjection,
  type ImmutablePublicationStore,
  type PublicProjectionDirectory,
} from "./publication.js";
import type { ResourceRoutingDirectory } from "./resource-directory.js";

const publishedPayload = z
  .object({
    workspaceId: z.string().min(1).max(200),
    skillId: z.string().min(1).max(200),
    skillSlug: z.string().min(1).max(120),
    versionId: z.string().min(1).max(200),
    currentVersionId: z.string().min(1).max(200),
    semanticVersion: z.string().min(1).max(160),
    sourceObjectKey: z.string().min(1).max(1_024),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    publishedAt: z.iso.datetime({ offset: true }).optional(),
    searchText: z.string().max(2_000_000),
    document: z.record(z.string(), z.unknown()),
  })
  .strict();

const unpublishedPayload = z
  .object({
    workspaceId: z.string().min(1).max(200),
    skillId: z.string().min(1).max(200),
    versionId: z.string().min(1).max(200),
  })
  .strict();

const publicStatsPayload = z
  .object({
    workspaceId: z.string().min(1).max(200),
    count: z.number().int().min(1).max(10_000),
  })
  .strict();

const publicSkillCountPayload = z
  .object({
    workspaceId: z.string().min(1).max(200),
    delta: z.union([z.literal(-1), z.literal(1)]),
  })
  .strict();

const routableResourceType = z.enum([
  "workspace",
  "skill",
  "skill_version",
  "context",
  "context_note",
]);

const resourceRoutePayload = z
  .object({
    workspaceId: z.string().min(1).max(200),
    resources: z
      .array(
        z
          .object({
            resourceType: routableResourceType,
            resourceId: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export interface RegionalProjectionEvent {
  readonly id: string;
  readonly regionId: string;
  readonly eventType:
    | "public_skill.published"
    | "public_skill.unpublished"
    | "public_stats.agent_skill_used"
    | "public_stats.skill_count_changed"
    | "resource_route.upsert";
  readonly workspaceId: string;
  readonly fencingEpoch: number;
  readonly sequence: number;
  readonly payload: unknown;
}

interface ProjectionOutboxRow extends Record<string, unknown> {
  readonly id: string;
  readonly workspace_id: string;
  readonly event_type: RegionalProjectionEvent["eventType"];
  readonly payload: unknown;
  readonly fencing_epoch: number | string;
  readonly sequence: number | string;
}

interface ProjectionOutboxSqlClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
  }>;
}

const eventType = z.enum([
  "public_skill.published",
  "public_skill.unpublished",
  "public_stats.agent_skill_used",
  "public_stats.skill_count_changed",
  "resource_route.upsert",
]);

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "UNKNOWN";
  return /^[A-Z0-9_:-]{1,160}$/u.test(message)
    ? message
    : "PUBLICATION_PROJECTION_FAILED";
}

function projectionSequence(value: unknown): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("PUBLICATION_OUTBOX_SEQUENCE_INVALID");
  }
  return sequence;
}

function fencingEpoch(value: unknown): number {
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("PUBLICATION_OUTBOX_FENCING_EPOCH_INVALID");
  }
  return epoch;
}

function sourcePublishedAt(
  payload: z.infer<typeof publishedPayload>,
): string | undefined {
  if (payload.publishedAt) return payload.publishedAt;
  const version = payload.document.version;
  if (!version || typeof version !== "object" || Array.isArray(version)) {
    return undefined;
  }
  const value = (version as Record<string, unknown>).publishedAt;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return undefined;
  }
  return new Date(value).toISOString();
}

/**
 * Claims at most one ordered event per workspace at a time, then continues with
 * that workspace's next event after acknowledgement. A failed workspace is
 * skipped for the rest of the invocation so one poison event cannot consume the
 * whole batch. Expired claims are recoverable and the projection itself is
 * idempotent, so worker termination cannot expose a partially copied bundle.
 */
export async function drainRegionalProjectionOutbox(input: {
  readonly regionId: string;
  readonly database: ProjectionOutboxSqlClient;
  readonly process: (event: RegionalProjectionEvent) => Promise<void>;
  readonly limit?: number;
  readonly leaseSeconds?: number;
  readonly claimToken?: string;
  readonly onEvent?: (event: {
    readonly type: "processed" | "failed";
    readonly eventId: string;
    readonly errorCode?: string;
  }) => void | Promise<void>;
}): Promise<{ readonly processed: number; readonly failed: number }> {
  const limit = input.limit ?? 50;
  const leaseSeconds = input.leaseSeconds ?? 60;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("PUBLICATION_OUTBOX_LIMIT_INVALID");
  }
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 600) {
    throw new Error("PUBLICATION_OUTBOX_LEASE_INVALID");
  }
  const claimToken = input.claimToken ?? `projection-claim:${crypto.randomUUID()}`;
  let processed = 0;
  let failed = 0;
  const blockedWorkspaceIds = new Set<string>();
  while (processed + failed < limit) {
    const claimed = await input.database.query(
      `WITH candidates AS (
         SELECT candidate.id
           FROM regional_projection_outbox candidate
          WHERE candidate.processed_at IS NULL
            AND (candidate.claimed_at IS NULL OR
                 candidate.claimed_at < now() - ($2::integer * interval '1 second'))
            AND NOT (candidate.workspace_id = ANY($4::text[]))
            AND NOT EXISTS (
              SELECT 1
                FROM regional_projection_outbox earlier
               WHERE earlier.workspace_id = candidate.workspace_id
                 AND earlier.processed_at IS NULL
                 AND earlier.sequence < candidate.sequence
            )
          ORDER BY candidate.created_at, candidate.id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE regional_projection_outbox event
          SET claim_token = $3, claimed_at = now(), attempts = attempts + 1
         FROM candidates
        WHERE event.id = candidates.id
        RETURNING event.id, event.workspace_id, event.event_type,
                  event.payload, event.fencing_epoch, event.sequence`,
      [limit - processed - failed, leaseSeconds, claimToken, [...blockedWorkspaceIds]],
    );
    if (claimed.rows.length === 0) break;
    for (const row of claimed.rows as readonly ProjectionOutboxRow[]) {
      const event: RegionalProjectionEvent = {
        id: row.id,
        regionId: input.regionId,
        eventType: eventType.parse(row.event_type),
        workspaceId: row.workspace_id,
        fencingEpoch: fencingEpoch(row.fencing_epoch),
        sequence: projectionSequence(row.sequence),
        payload: row.payload,
      };
      try {
        await input.process(event);
        const acknowledged = await input.database.query(
          `UPDATE regional_projection_outbox
              SET processed_at = now(), claim_token = NULL, claimed_at = NULL,
                  last_error = NULL
            WHERE id = $1 AND claim_token = $2 AND processed_at IS NULL
            RETURNING id`,
          [row.id, claimToken],
        );
        if (acknowledged.rows.length !== 1) {
          throw new Error("PUBLICATION_OUTBOX_CLAIM_LOST");
        }
        processed += 1;
        await input.onEvent?.({ type: "processed", eventId: row.id });
      } catch (error) {
        const errorCode = safeFailureCode(error);
        await input.database.query(
          `UPDATE regional_projection_outbox
              SET claim_token = NULL, claimed_at = NULL, last_error = $3
            WHERE id = $1 AND claim_token = $2 AND processed_at IS NULL`,
          [row.id, claimToken, errorCode],
        );
        blockedWorkspaceIds.add(row.workspace_id);
        failed += 1;
        await input.onEvent?.({ type: "failed", eventId: row.id, errorCode });
      }
    }
  }
  return { processed, failed };
}

/**
 * Retires acknowledged rows after a replay window. Sequence allocation lives
 * in regional_projection_sequences, so removing history cannot reuse sequence
 * numbers or weaken ordered processing.
 */
export async function cleanupProcessedRegionalProjectionOutbox(input: {
  readonly database: ProjectionOutboxSqlClient;
  readonly retentionSeconds?: number;
  readonly limit?: number;
}): Promise<number> {
  const retentionSeconds = input.retentionSeconds ?? 7 * 24 * 60 * 60;
  const limit = input.limit ?? 1_000;
  if (
    !Number.isSafeInteger(retentionSeconds) ||
    retentionSeconds < 60 * 60 ||
    retentionSeconds > 90 * 24 * 60 * 60
  ) {
    throw new Error("PUBLICATION_OUTBOX_RETENTION_INVALID");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("PUBLICATION_OUTBOX_CLEANUP_LIMIT_INVALID");
  }
  const retired = await input.database.query(
    `WITH candidates AS (
       SELECT id
         FROM regional_projection_outbox
        WHERE processed_at IS NOT NULL
          AND processed_at < now() - ($1::integer * interval '1 second')
        ORDER BY processed_at, id
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM regional_projection_outbox event
      USING candidates
      WHERE event.id = candidates.id
      RETURNING event.id`,
    [retentionSeconds, limit],
  );
  return retired.rows.length;
}

/**
 * Removes checkpointed event IDs after the same replay window. Pre-checkpoint
 * rows have no sequence and remain as a finite compatibility set.
 */
export async function cleanupPublicStatsProjectionEvents(input: {
  readonly database: ProjectionOutboxSqlClient;
  readonly retentionSeconds?: number;
  readonly limit?: number;
}): Promise<number> {
  const retentionSeconds = input.retentionSeconds ?? 7 * 24 * 60 * 60;
  const limit = input.limit ?? 1_000;
  if (
    !Number.isSafeInteger(retentionSeconds) ||
    retentionSeconds < 60 * 60 ||
    retentionSeconds > 90 * 24 * 60 * 60
  ) {
    throw new Error("PUBLIC_STATS_PROJECTION_RETENTION_INVALID");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("PUBLIC_STATS_PROJECTION_CLEANUP_LIMIT_INVALID");
  }
  const retired = await input.database.query(
    `WITH candidates AS (
       SELECT event.event_id
         FROM public_stats_projection_events event
         JOIN public_stats_projection_checkpoints checkpoint
           ON checkpoint.workspace_id = event.workspace_id
        WHERE event.sequence IS NOT NULL
          AND event.fencing_epoch IS NOT NULL
          AND event.applied_at < now() - ($1::integer * interval '1 second')
          AND (
            checkpoint.fencing_epoch > event.fencing_epoch
            OR (
              checkpoint.fencing_epoch = event.fencing_epoch
              AND checkpoint.sequence >= event.sequence
            )
          )
        ORDER BY event.applied_at, event.event_id
        LIMIT $2
        FOR UPDATE OF event SKIP LOCKED
     )
     DELETE FROM public_stats_projection_events event
      USING candidates
      WHERE event.event_id = candidates.event_id
      RETURNING event.event_id`,
    [retentionSeconds, limit],
  );
  return retired.rows.length;
}

export async function applyPublicStatsProjectionCheckpoint(input: {
  readonly database: ProjectionOutboxSqlClient;
  readonly eventId: string;
  readonly workspaceId: string;
  readonly eventType:
    "public_stats.agent_skill_used" | "public_stats.skill_count_changed";
  readonly fencingEpoch: number;
  readonly sequence: number;
  readonly agentSkillUses: number;
  readonly totalSkills: number;
}): Promise<void> {
  await input.database.query(
    `WITH claimed AS (
       INSERT INTO public_stats_projection_events
         (event_id, workspace_id, event_type, fencing_epoch, sequence)
       VALUES ($1, $2, $3, $6, $7)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING workspace_id, fencing_epoch, sequence
     ),
     advanced AS (
       INSERT INTO public_stats_projection_checkpoints
         (workspace_id, fencing_epoch, sequence, updated_at)
       SELECT workspace_id, fencing_epoch, sequence, now()
         FROM claimed
       ON CONFLICT (workspace_id) DO UPDATE
         SET fencing_epoch = EXCLUDED.fencing_epoch,
             sequence = EXCLUDED.sequence,
             updated_at = now()
       WHERE public_stats_projection_checkpoints.fencing_epoch <
               EXCLUDED.fencing_epoch
          OR (
            public_stats_projection_checkpoints.fencing_epoch =
              EXCLUDED.fencing_epoch
            AND public_stats_projection_checkpoints.sequence <
              EXCLUDED.sequence
          )
       RETURNING workspace_id
     )
     INSERT INTO public_stats_counters
       (id, agent_skill_uses, total_skills, updated_at)
     SELECT $2, $4, $5, now() FROM advanced
     ON CONFLICT (id) DO UPDATE
       SET agent_skill_uses =
             public_stats_counters.agent_skill_uses +
             EXCLUDED.agent_skill_uses,
           total_skills =
             public_stats_counters.total_skills + EXCLUDED.total_skills,
           updated_at = now()`,
    [
      input.eventId,
      input.workspaceId,
      input.eventType,
      input.agentSkillUses,
      input.totalSkills,
      input.fencingEpoch,
      input.sequence,
    ],
  );
}

/**
 * Applies a regional publication event only while its placement epoch is
 * current. Stale cells therefore cannot republish after a workspace move.
 */
export async function applyRegionalPublicProjection(input: {
  readonly event: RegionalProjectionEvent;
  readonly placements: WorkspacePlacementDirectory;
  readonly resolveWorkspaceSlug: (workspaceId: string) => Promise<string | null>;
  readonly regionalStore: ImmutablePublicationStore;
  readonly publicStore: ImmutablePublicationStore;
  readonly directory: PublicProjectionDirectory;
  readonly resourceDirectory?: ResourceRoutingDirectory;
  readonly applyPublicStats?: (input: {
    readonly eventId: string;
    readonly workspaceId: string;
    readonly fencingEpoch: number;
    readonly sequence: number;
    readonly eventType:
      "public_stats.agent_skill_used" | "public_stats.skill_count_changed";
    readonly agentSkillUses: number;
    readonly totalSkills: number;
  }) => Promise<void>;
}): Promise<{ readonly objectKey: string | null }> {
  const placement = await input.placements.get(input.event.workspaceId);
  const currentActiveSource =
    placement?.state === "active" &&
    placement.regionId === input.event.regionId &&
    placement.epoch === input.event.fencingEpoch;
  const quiescingSource =
    placement?.state === "moving" &&
    placement.migration?.sourceRegionId === input.event.regionId &&
    placement.migration.sourceEpoch === input.event.fencingEpoch;
  if (!currentActiveSource && !quiescingSource) {
    throw new Error("PUBLICATION_FENCING_EPOCH_STALE");
  }
  if (input.event.eventType === "resource_route.upsert") {
    const payload = resourceRoutePayload.parse(input.event.payload);
    if (payload.workspaceId !== input.event.workspaceId) {
      throw new Error("RESOURCE_ROUTE_WORKSPACE_MISMATCH");
    }
    if (!input.resourceDirectory) {
      throw new Error("RESOURCE_ROUTE_PROJECTOR_UNAVAILABLE");
    }
    for (const resource of payload.resources) {
      await input.resourceDirectory.upsert({
        workspaceId: payload.workspaceId,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
      });
    }
    return { objectKey: null };
  }
  if (input.event.eventType === "public_stats.agent_skill_used") {
    const payload = publicStatsPayload.parse(input.event.payload);
    if (payload.workspaceId !== input.event.workspaceId) {
      throw new Error("PUBLICATION_WORKSPACE_MISMATCH");
    }
    if (!input.applyPublicStats) {
      throw new Error("PUBLIC_STATS_PROJECTOR_UNAVAILABLE");
    }
    await input.applyPublicStats({
      eventId: input.event.id,
      workspaceId: payload.workspaceId,
      fencingEpoch: input.event.fencingEpoch,
      sequence: input.event.sequence,
      eventType: input.event.eventType,
      agentSkillUses: payload.count,
      totalSkills: 0,
    });
    return { objectKey: null };
  }
  if (input.event.eventType === "public_stats.skill_count_changed") {
    const payload = publicSkillCountPayload.parse(input.event.payload);
    if (payload.workspaceId !== input.event.workspaceId) {
      throw new Error("PUBLICATION_WORKSPACE_MISMATCH");
    }
    if (!input.applyPublicStats) {
      throw new Error("PUBLIC_STATS_PROJECTOR_UNAVAILABLE");
    }
    await input.applyPublicStats({
      eventId: input.event.id,
      workspaceId: payload.workspaceId,
      fencingEpoch: input.event.fencingEpoch,
      sequence: input.event.sequence,
      eventType: input.event.eventType,
      agentSkillUses: 0,
      totalSkills: payload.delta,
    });
    return { objectKey: null };
  }
  if (input.event.eventType === "public_skill.unpublished") {
    const payload = unpublishedPayload.parse(input.event.payload);
    if (payload.workspaceId !== input.event.workspaceId) {
      throw new Error("PUBLICATION_WORKSPACE_MISMATCH");
    }
    await input.directory.unpublish({
      ...payload,
      projectionSequence: input.event.sequence,
    });
    return { objectKey: null };
  }
  const payload = publishedPayload.parse(input.event.payload);
  if (payload.workspaceId !== input.event.workspaceId) {
    throw new Error("PUBLICATION_WORKSPACE_MISMATCH");
  }
  const workspaceSlug = await input.resolveWorkspaceSlug(payload.workspaceId);
  if (!workspaceSlug) throw new Error("PUBLICATION_WORKSPACE_NOT_FOUND");
  const publishedAt = sourcePublishedAt(payload);
  const objectKey = await publishGlobalProjection({
    source: input.regionalStore,
    destination: input.publicStore,
    directory: input.directory,
    sourceKey: payload.sourceObjectKey,
    workspaceId: payload.workspaceId,
    workspaceSlug,
    skillId: payload.skillId,
    skillSlug: payload.skillSlug,
    versionId: payload.versionId,
    currentVersionId: payload.currentVersionId,
    semanticVersion: payload.semanticVersion,
    digest: payload.digest as `sha256:${string}`,
    projectionSequence: input.event.sequence,
    ...(publishedAt ? { publishedAt } : {}),
    document: payload.document,
    searchText: payload.searchText,
  });
  return { objectKey };
}
