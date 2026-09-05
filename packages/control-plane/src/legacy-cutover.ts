import {
  PostgresWorkspaceMigrationOperations,
  type MigrationSqlPool,
  type WorkspaceMigrationObjectStore,
} from "./concrete-migration.js";
import {
  migrateWorkspaceWithJournal,
  isWorkspaceMigrationRecoveryPending,
  PostgresWorkspaceMigrationJournal,
  runWorkspaceRollbackDrill,
  type MigrationCheck,
  type WorkspaceMigrationProof,
} from "./migration.js";
import { createPostgresWorkspacePlacementDirectory } from "./placement.js";
import type { WorkspacePlacement } from "./placement.js";
import {
  PostgresPublicProjectionDirectory,
  publishGlobalProjection,
  type ImmutablePublicationStore,
} from "./publication.js";

export type CutoverObjectStore = WorkspaceMigrationObjectStore &
  ImmutablePublicationStore;

interface PlacementRow extends Record<string, unknown> {
  readonly workspace_id: string;
}

interface PublicSkillRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly skill_id: string;
  readonly skill_slug: string;
  readonly skill_name: string;
  readonly skill_description: string;
  readonly skill_tags: readonly string[];
  readonly skill_created_at: Date | string;
  readonly skill_updated_at: Date | string;
  readonly current_version_id: string;
  readonly current_semantic_version: string;
  readonly version_id: string;
  readonly revision: number;
  readonly semantic_version: string;
  readonly base_version_id: string | null;
  readonly proposed_bump: "patch" | "minor" | "major" | null;
  readonly source: "human" | "agent_amendment" | "import";
  readonly content_digest: `sha256:${string}`;
  readonly r2_object_key: string;
  readonly bundle_byte_size: string | number;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly learning_metadata: Readonly<Record<string, unknown>>;
  readonly amendment_operations: readonly Readonly<Record<string, unknown>>[];
  readonly caller_declaration: Readonly<Record<string, unknown>>;
  readonly policy_decision: Readonly<Record<string, unknown>>;
  readonly change_summary: string;
  readonly created_by_actor_type: "user" | "service_principal" | "system";
  readonly created_by_actor_id: string;
  readonly created_by_agent: string | null;
  readonly created_by_model: string | null;
  readonly created_for_user_id: string | null;
  readonly published_at: Date | string;
  readonly version_created_at: Date | string;
  readonly published_search_text: string;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function verificationContext(row: WorkspacePlacement, targetRegionId: string) {
  return {
    namespace: row.namespace,
    sourceRegionId: "legacy",
    targetRegionId,
    sourceEpoch: Math.max(1, row.epoch - 1),
    movingEpoch: row.epoch,
    recoveryFence: row.epoch,
    recoveryOwnerId: "legacy-cutover-verifier",
    recoveryLeaseExpiresAt: Date.now() + 60_000,
  };
}

async function verifyExistingCopy(
  row: WorkspacePlacement,
  targetRegionId: string,
  operations: PostgresWorkspaceMigrationOperations,
): Promise<readonly MigrationCheck[]> {
  const context = verificationContext(row, targetRegionId);
  const checks = [
    ...(await operations.verifyDatabase(context)),
    ...(await operations.verifyBundles(context)),
  ];
  if (checks.length === 0 || checks.some((check) => !check.matched)) {
    throw new Error(`TOPOLOGY_CUTOVER_EXISTING_COPY_INVALID:${row.namespace}`);
  }
  return checks;
}

/**
 * Moves every compatibility workspace through the same fenced, verified path
 * used by an ordinary cell migration. Active target placements are verified
 * again so an interrupted batch can be resumed without recopying good data.
 */
export async function migrateLegacyWorkspaceBatch(input: {
  readonly control: MigrationSqlPool;
  readonly source: MigrationSqlPool;
  readonly target: MigrationSqlPool;
  readonly sourceObjects: WorkspaceMigrationObjectStore;
  readonly targetObjects: CutoverObjectStore;
  readonly targetRegionId: string;
}): Promise<{
  readonly migrated: readonly WorkspaceMigrationProof[];
  readonly verifiedExisting: readonly {
    readonly workspaceId: string;
    readonly checks: readonly MigrationCheck[];
  }[];
}> {
  await input.control.query(
    `INSERT INTO workspace_placements (workspace_id, region_id, epoch, state)
     SELECT workspace.id, 'legacy', 1, 'active'
       FROM workspaces workspace
       LEFT JOIN workspace_placements placement
         ON placement.workspace_id = workspace.id
      WHERE placement.workspace_id IS NULL
     ON CONFLICT (workspace_id) DO NOTHING`,
  );
  const placements = await input.control.query<PlacementRow>(
    `SELECT workspace_id
       FROM workspace_placements
      ORDER BY workspace_id`,
  );
  const directory = createPostgresWorkspacePlacementDirectory(input.control);
  const journal = new PostgresWorkspaceMigrationJournal(input.control);
  const migrated: WorkspaceMigrationProof[] = [];
  const verifiedExisting: {
    workspaceId: string;
    checks: readonly MigrationCheck[];
  }[] = [];

  for (const row of placements.rows) {
    const current = await directory.get(row.workspace_id);
    if (!current) {
      throw new Error(`TOPOLOGY_CUTOVER_PLACEMENT_MISSING:${row.workspace_id}`);
    }
    const operations = new PostgresWorkspaceMigrationOperations(
      input.source,
      input.target,
      input.control,
      input.sourceObjects,
      input.targetObjects,
    );
    const recovering = isWorkspaceMigrationRecoveryPending(current);
    if (!recovering && current.state !== "active") {
      throw new Error(`TOPOLOGY_CUTOVER_PLACEMENT_NOT_ACTIVE:${row.workspace_id}`);
    }
    if (!recovering && current.regionId === input.targetRegionId) {
      verifiedExisting.push({
        workspaceId: row.workspace_id,
        checks: await verifyExistingCopy(current, input.targetRegionId, operations),
      });
      continue;
    }
    if (!recovering && current.regionId !== "legacy") {
      throw new Error(`TOPOLOGY_CUTOVER_SOURCE_REGION_INVALID:${row.workspace_id}`);
    }
    if (!recovering) {
      await runWorkspaceRollbackDrill({
        directory,
        workspaceId: row.workspace_id,
        targetRegionId: input.targetRegionId,
        operations,
      });
    }
    const migrate = () =>
      migrateWorkspaceWithJournal({
        directory,
        journal,
        workspaceId: row.workspace_id,
        targetRegionId: input.targetRegionId,
        operations,
        rollbackTested: true,
      });
    let result;
    try {
      result = await migrate();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "DATAFN_MIGRATION_ROLLED_BACK"
      ) {
        throw error;
      }
      result = await migrate();
    }
    migrated.push(result.proof);
  }
  return { migrated, verifiedExisting };
}

/** Recounts active regional skills after every legacy workspace is fenced. */
export async function reconcileLegacyPublicSkillTotals(input: {
  readonly control: MigrationSqlPool;
  readonly regional: MigrationSqlPool;
  readonly regionId: string;
}): Promise<{ readonly reconciledWorkspaces: number }> {
  const placements = await input.control.query<{ workspace_id: string }>(
    `SELECT workspace_id
       FROM workspace_placements
      WHERE region_id = $1 AND state = 'active'
      ORDER BY workspace_id`,
    [input.regionId],
  );
  if (placements.rows.length === 0) return { reconciledWorkspaces: 0 };
  const workspaceIds = placements.rows.map((row) => row.workspace_id);
  const regional = await input.regional.connect();
  try {
    await regional.query("BEGIN");
    await regional.query(
      `INSERT INTO regional_workspace_migration_fences
         (workspace_id, source_epoch, active_epoch)
       SELECT workspace_id, 0, 1
         FROM unnest($1::text[]) AS workspace(workspace_id)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceIds],
    );
    // Regional writes hold a shared lock on this row. Taking every row
    // exclusively waits for in-flight writes and blocks new writes until the
    // exact count has replaced every pre-fence projection delta.
    await regional.query(
      `SELECT workspace_id
         FROM regional_workspace_migration_fences
        WHERE workspace_id = ANY($1::text[])
        ORDER BY workspace_id
        FOR UPDATE`,
      [workspaceIds],
    );
    const deadline = Date.now() + 75_000;
    for (;;) {
      const pending = await regional.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM regional_projection_outbox
          WHERE workspace_id = ANY($1::text[]) AND processed_at IS NULL`,
        [workspaceIds],
      );
      if (pending.rows[0]?.count === "0") break;
      if (Date.now() >= deadline) {
        throw new Error("TOPOLOGY_PUBLIC_STATS_OUTBOX_NOT_DRAINED");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const counts = await regional.query<{
      workspace_id: string;
      total_skills: string;
    }>(
      `SELECT workspace_id, count(*)::text AS total_skills
         FROM skills
        WHERE workspace_id = ANY($1::text[]) AND archived_at IS NULL
        GROUP BY workspace_id`,
      [workspaceIds],
    );
    const totalByWorkspace = new Map(
      counts.rows.map((row) => [row.workspace_id, row.total_skills]),
    );
    const reconciled = await input.control.query<{ id: string }>(
      `INSERT INTO public_stats_counters
         (id, agent_skill_uses, total_skills, updated_at)
       SELECT workspace_id, 0, total_skills, now()
         FROM unnest($1::text[], $2::numeric[])
              AS workspace_total(workspace_id, total_skills)
       ON CONFLICT (id) DO UPDATE
         SET total_skills = EXCLUDED.total_skills,
             updated_at = now()
       RETURNING id`,
      [
        workspaceIds,
        workspaceIds.map((workspaceId) => totalByWorkspace.get(workspaceId) ?? "0"),
      ],
    );
    await regional.query("COMMIT");
    return { reconciledWorkspaces: reconciled.rows.length };
  } catch (error) {
    await regional.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    regional.release();
  }
}

/**
 * Copies every current public bundle into the private global bucket, verifies
 * both digests, and only then exposes its metadata projection.
 */
export async function backfillLegacyPublicSkillProjections(input: {
  readonly control: MigrationSqlPool;
  readonly regional: MigrationSqlPool;
  readonly regionalObjects: ImmutablePublicationStore;
  readonly publicObjects: ImmutablePublicationStore;
  readonly regionId: string;
}): Promise<{
  readonly projected: number;
  readonly reconciledWorkspaces: number;
}> {
  const workspaces = await input.control.query<{
    workspace_id: string;
    workspace_slug: string;
  }>(
    `SELECT placement.workspace_id, workspace.slug AS workspace_slug
       FROM workspace_placements placement
       JOIN workspaces workspace ON workspace.id = placement.workspace_id
      WHERE placement.region_id = $1 AND placement.state = 'active'
      ORDER BY placement.workspace_id`,
    [input.regionId],
  );
  const directory = new PostgresPublicProjectionDirectory(input.control);
  let projected = 0;
  for (const workspace of workspaces.rows) {
    const skills = await input.regional.query<PublicSkillRow>(
      `SELECT skill.workspace_id, skill.id AS skill_id, skill.slug AS skill_slug,
              skill.name AS skill_name, skill.description AS skill_description,
              skill.tags AS skill_tags, skill.created_at AS skill_created_at,
              skill.updated_at AS skill_updated_at,
              skill.published_search_text,
              skill.current_published_version_id AS current_version_id,
              current_version.semantic_version AS current_semantic_version,
              version.id AS version_id, version.revision,
              version.semantic_version, version.base_version_id,
              version.proposed_bump, version.source, version.content_digest,
              version.r2_object_key, version.bundle_byte_size, version.manifest,
              version.learning_metadata, version.amendment_operations,
              version.caller_declaration, version.policy_decision,
              version.change_summary, version.created_by_actor_type,
              version.created_by_actor_id, version.created_by_agent,
              version.created_by_model, version.created_for_user_id,
              version.published_at, version.created_at AS version_created_at
         FROM skills skill
         JOIN skill_versions version
           ON version.skill_id = skill.id
          AND version.workspace_id = skill.workspace_id
         JOIN skill_versions current_version
           ON current_version.id = skill.current_published_version_id
          AND current_version.workspace_id = skill.workspace_id
        WHERE skill.workspace_id = $1
          AND skill.visibility = 'public'
          AND skill.archived_at IS NULL
          AND version.status = 'published'
        ORDER BY skill.id, version.published_at, version.id`,
      [workspace.workspace_id],
    );
    for (const row of skills.rows) {
      const version = {
        id: row.version_id,
        workspaceId: row.workspace_id,
        skillId: row.skill_id,
        revision: row.revision,
        semanticVersion: row.semantic_version,
        status: "published",
        baseVersionId: row.base_version_id,
        proposedBump: row.proposed_bump,
        source: row.source,
        digest: row.content_digest,
        objectKey: row.r2_object_key,
        byteSize: Number(row.bundle_byte_size),
        manifest: row.manifest,
        learningMetadata: row.learning_metadata,
        amendmentOperations: row.amendment_operations,
        callerDeclaration: row.caller_declaration,
        policyDecision: row.policy_decision,
        changeSummary: row.change_summary,
        createdByActorType: row.created_by_actor_type,
        createdByActorId: row.created_by_actor_id,
        createdByAgent: row.created_by_agent,
        createdByModel: row.created_by_model,
        createdForUserId: row.created_for_user_id,
        publishedAt: iso(row.published_at),
        createdAt: iso(row.version_created_at),
      } as const;
      await publishGlobalProjection({
        source: input.regionalObjects,
        destination: input.publicObjects,
        directory,
        sourceKey: row.r2_object_key,
        workspaceId: row.workspace_id,
        workspaceSlug: workspace.workspace_slug,
        skillId: row.skill_id,
        skillSlug: row.skill_slug,
        versionId: row.version_id,
        currentVersionId: row.current_version_id,
        semanticVersion: row.semantic_version,
        digest: row.content_digest,
        projectionSequence: 0,
        publishedAt: version.publishedAt,
        searchText: row.published_search_text,
        document: {
          skill: {
            id: row.skill_id,
            workspaceId: row.workspace_id,
            slug: row.skill_slug,
            name: row.skill_name,
            description: row.skill_description,
            tags: row.skill_tags,
            visibility: "public",
            currentPublishedVersionId: row.current_version_id,
            currentSemanticVersion: row.current_semantic_version,
            archivedAt: null,
            createdAt: iso(row.skill_created_at),
            updatedAt: iso(row.skill_updated_at),
          },
          version,
        },
      });
      projected += 1;
    }
  }
  const totals = await reconcileLegacyPublicSkillTotals(input);
  return { projected, ...totals };
}
