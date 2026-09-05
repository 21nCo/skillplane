import type { SkillRecord, SkillVersionRecord } from "./skills.js";

interface ProjectionSqlClient {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}

interface ProjectionRow extends Record<string, unknown> {
  readonly search_text: string;
  readonly version_document: SkillVersionRecord;
}

export const ROUTABLE_RESOURCE_TYPES = [
  "workspace",
  "skill",
  "skill_version",
  "context",
  "context_note",
] as const;
export type RoutableResourceType = (typeof ROUTABLE_RESOURCE_TYPES)[number];

function epoch(value: number | undefined): number {
  const resolved = value ?? 1;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("WORKSPACE_ROUTING_EPOCH_INVALID");
  }
  return resolved;
}

async function enqueue(
  client: ProjectionSqlClient,
  input: {
    readonly workspaceId: string;
    readonly eventType:
      | "public_skill.published"
      | "public_skill.unpublished"
      | "public_stats.agent_skill_used"
      | "public_stats.skill_count_changed"
      | "resource_route.upsert";
    readonly payload: Readonly<Record<string, unknown>>;
    readonly fencingEpoch?: number | undefined;
  },
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.workspaceId]);
  await client.query(
    `WITH next_sequence AS (
       INSERT INTO regional_projection_sequences
         (workspace_id, last_sequence, updated_at)
       SELECT $2, COALESCE(MAX(sequence), 0) + 1, now()
         FROM regional_projection_outbox
        WHERE workspace_id = $2
       ON CONFLICT (workspace_id) DO UPDATE
         SET last_sequence =
               GREATEST(
                 regional_projection_sequences.last_sequence,
                 (
                   SELECT COALESCE(MAX(sequence), 0)
                     FROM regional_projection_outbox
                    WHERE workspace_id = $2
                 )
               ) + 1,
             updated_at = now()
       RETURNING last_sequence
     )
     INSERT INTO regional_projection_outbox
       (id, workspace_id, event_type, payload, fencing_epoch, sequence)
     SELECT $1, $2, $3, $4::jsonb, $5, last_sequence
       FROM next_sequence`,
    [
      `regional-projection:${crypto.randomUUID()}`,
      input.workspaceId,
      input.eventType,
      JSON.stringify(input.payload),
      epoch(input.fencingEpoch),
    ],
  );
}

export async function enqueueResourceRoutingProjection(
  client: ProjectionSqlClient,
  input: {
    readonly workspaceId: string;
    readonly resources: readonly {
      readonly resourceType: RoutableResourceType;
      readonly resourceId: string;
    }[];
    readonly fencingEpoch?: number | undefined;
  },
): Promise<void> {
  if (input.resources.length === 0) return;
  await enqueue(client, {
    workspaceId: input.workspaceId,
    eventType: "resource_route.upsert",
    fencingEpoch: input.fencingEpoch,
    payload: {
      workspaceId: input.workspaceId,
      resources: input.resources,
    },
  });
}

export async function enqueueSkillCountProjection(
  client: ProjectionSqlClient,
  input: {
    readonly workspaceId: string;
    readonly delta: -1 | 1;
    readonly fencingEpoch?: number | undefined;
  },
): Promise<void> {
  await enqueue(client, {
    workspaceId: input.workspaceId,
    eventType: "public_stats.skill_count_changed",
    fencingEpoch: input.fencingEpoch,
    payload: { workspaceId: input.workspaceId, delta: input.delta },
  });
}

export async function enqueueAgentSkillUseProjection(
  client: ProjectionSqlClient,
  input: {
    readonly workspaceId: string;
    readonly fencingEpoch?: number | undefined;
    readonly count?: number | undefined;
  },
): Promise<void> {
  const count = input.count ?? 1;
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) {
    throw new Error("PUBLIC_STATS_INCREMENT_INVALID");
  }
  await enqueue(client, {
    workspaceId: input.workspaceId,
    eventType: "public_stats.agent_skill_used",
    fencingEpoch: input.fencingEpoch,
    payload: { workspaceId: input.workspaceId, count },
  });
}

export async function enqueuePublishedSkillProjection(
  client: ProjectionSqlClient,
  input: {
    readonly skill: SkillRecord;
    readonly version: SkillVersionRecord;
    readonly searchText: string;
    readonly fencingEpoch?: number | undefined;
  },
): Promise<void> {
  if (!input.version.semanticVersion) {
    throw new Error("PUBLICATION_SEMVER_MISSING");
  }
  if (!input.skill.currentPublishedVersionId) {
    throw new Error("PUBLICATION_CURRENT_VERSION_MISSING");
  }
  await enqueue(client, {
    workspaceId: input.skill.workspaceId,
    eventType: "public_skill.published",
    fencingEpoch: input.fencingEpoch,
    payload: {
      workspaceId: input.skill.workspaceId,
      skillId: input.skill.id,
      skillSlug: input.skill.slug,
      versionId: input.version.id,
      currentVersionId: input.skill.currentPublishedVersionId,
      semanticVersion: input.version.semanticVersion,
      sourceObjectKey: input.version.objectKey,
      digest: input.version.digest,
      publishedAt: input.version.publishedAt,
      searchText: input.searchText,
      document: { skill: input.skill, version: input.version },
    },
  });
}

export async function enqueueUnpublishedSkillProjection(
  client: ProjectionSqlClient,
  input: {
    readonly workspaceId: string;
    readonly skillId: string;
    readonly versionId: string;
    readonly fencingEpoch?: number | undefined;
  },
): Promise<void> {
  await enqueue(client, {
    workspaceId: input.workspaceId,
    eventType: "public_skill.unpublished",
    fencingEpoch: input.fencingEpoch,
    payload: {
      workspaceId: input.workspaceId,
      skillId: input.skillId,
      versionId: input.versionId,
    },
  });
}

/** Enqueues public state using only rows locked by the caller. */
export async function enqueueCurrentSkillProjection(
  client: ProjectionSqlClient,
  input: {
    readonly skill: SkillRecord;
    readonly fencingEpoch?: number | undefined;
    readonly includePublishedHistory?: boolean | undefined;
  },
): Promise<void> {
  const versionId = input.skill.currentPublishedVersionId;
  if (!versionId) return;
  if (input.skill.visibility !== "public" || input.skill.archivedAt) {
    await enqueueUnpublishedSkillProjection(client, {
      workspaceId: input.skill.workspaceId,
      skillId: input.skill.id,
      versionId,
      fencingEpoch: input.fencingEpoch,
    });
    return;
  }
  const result = await client.query(
    `SELECT skill.published_search_text AS search_text,
            jsonb_build_object(
              'id', version.id,
              'workspaceId', version.workspace_id,
              'skillId', version.skill_id,
              'revision', version.revision,
              'semanticVersion', version.semantic_version,
              'status', version.status,
              'baseVersionId', version.base_version_id,
              'proposedBump', version.proposed_bump,
              'source', version.source,
              'digest', version.content_digest,
              'objectKey', version.r2_object_key,
              'byteSize', version.bundle_byte_size,
              'manifest', version.manifest,
              'learningMetadata', version.learning_metadata,
              'amendmentOperations', version.amendment_operations,
              'callerDeclaration', version.caller_declaration,
              'policyDecision', version.policy_decision,
              'changeSummary', version.change_summary,
              'createdByActorType', version.created_by_actor_type,
              'createdByActorId', version.created_by_actor_id,
              'createdByAgent', version.created_by_agent,
              'createdByModel', version.created_by_model,
              'createdForUserId', version.created_for_user_id,
              'publishedAt', version.published_at,
              'createdAt', version.created_at
            ) AS version_document
       FROM skills skill
       JOIN skill_versions version
         ON version.skill_id = skill.id
        AND version.workspace_id = skill.workspace_id
      WHERE skill.id = $1 AND skill.workspace_id = $2
        AND version.status = 'published'
        AND ($3::boolean OR version.id = skill.current_published_version_id)
      ORDER BY (version.id = skill.current_published_version_id) DESC,
               version.published_at, version.id`,
    [input.skill.id, input.skill.workspaceId, input.includePublishedHistory ?? false],
  );
  const rows = result.rows as readonly ProjectionRow[];
  if (!rows.some((row) => row.version_document.id === versionId)) {
    throw new Error("PUBLICATION_CURRENT_VERSION_MISSING");
  }
  for (const row of rows) {
    await enqueuePublishedSkillProjection(client, {
      skill: input.skill,
      version: row.version_document,
      searchText: row.search_text,
      fencingEpoch: input.fencingEpoch,
    });
  }
}
