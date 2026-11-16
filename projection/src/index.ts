import { cleanupProjectionRetention } from "./retention.js";
import {
  PostgresPublicProjectionDirectory,
  applyPublicStatsProjectionCheckpoint,
  applyRegionalPublicProjection,
  createImmutableObjectPublicationStore,
  createPostgresResourceRoutingDirectory,
  createPostgresWorkspacePlacementDirectory,
  drainRegionalProjectionOutbox,
} from "@skillplane/control-plane";
import {
  createControlDatabaseClient,
  createRegionalDatabaseClient,
} from "@skillplane/db";
import {
  createBackgroundJobRegistry,
  drainBackgroundJobs,
  type BackgroundJobDrainResult,
  type BackgroundJobHandler,
} from "@skillplane/domain";

interface HyperdriveBinding {
  readonly connectionString: string;
}

interface ProjectionBindings {
  readonly CONTROL_DATABASE: HyperdriveBinding;
  readonly CELL_DATABASE: HyperdriveBinding;
  readonly CELL_BUNDLES: R2Bucket;
  readonly PUBLIC_BUNDLES: R2Bucket;
  readonly SKILLPLANE_REGION_ID: string;
}

/** Handlers for this cell's background jobs, keyed by kind. */
export const projectionJobHandlers: readonly BackgroundJobHandler[] = [];

// Each one-minute tick spends at most 45s starting projection events and 10s
// retiring retained rows; background jobs then get their own 10s to start
// runs, so neither side can starve the other.
const BACKGROUND_JOB_BUDGET_MS = 10_000;

function connectionString(value: HyperdriveBinding | undefined, name: string) {
  if (!value?.connectionString) throw new Error(`${name}_UNAVAILABLE`);
  return value.connectionString;
}

export async function drainProjectionCell(
  bindings: ProjectionBindings,
  options: { readonly jobHandlers?: readonly BackgroundJobHandler[] } = {},
): Promise<{
  readonly processed: number;
  readonly failed: number;
  readonly jobs: BackgroundJobDrainResult;
}> {
  const regionId = bindings.SKILLPLANE_REGION_ID.trim();
  if (!regionId) throw new Error("SKILLPLANE_REGION_ID_UNAVAILABLE");
  const registry = createBackgroundJobRegistry(
    options.jobHandlers ?? projectionJobHandlers,
  );
  const control = createControlDatabaseClient({
    connectionString: connectionString(bindings.CONTROL_DATABASE, "CONTROL_DATABASE"),
    applicationName: `skillplane-projection-control-${regionId}`,
    maxConnections: 2,
  });
  const regional = createRegionalDatabaseClient({
    connectionString: connectionString(bindings.CELL_DATABASE, "CELL_DATABASE"),
    applicationName: `skillplane-projection-regional-${regionId}`,
    maxConnections: 2,
  });
  try {
    const placements = createPostgresWorkspacePlacementDirectory(control.pool);
    const regionalStore = createImmutableObjectPublicationStore(bindings.CELL_BUNDLES);
    const publicStore = createImmutableObjectPublicationStore(bindings.PUBLIC_BUNDLES);
    const directory = new PostgresPublicProjectionDirectory(control.pool);
    const resourceDirectory = createPostgresResourceRoutingDirectory(control.pool);
    // Jobs run even when projection work fails, and that failure is rethrown
    // after them so the tick still reports it.
    const projection = drainRegionalProjectionOutbox({
      regionId,
      database: regional.pool,
      limit: 50_000,
      // Stop starting work after 45s; an in-flight operation may finish later.
      maxDurationMs: 45_000,
      process: (event) =>
        applyRegionalPublicProjection({
          event,
          placements,
          regionalStore,
          publicStore,
          directory,
          resourceDirectory,
          async applyPublicStats({
            eventId,
            workspaceId,
            fencingEpoch,
            sequence,
            eventType,
            agentSkillUses,
            totalSkills,
          }) {
            await applyPublicStatsProjectionCheckpoint({
              database: control.pool,
              eventId,
              workspaceId,
              eventType,
              fencingEpoch,
              sequence,
              agentSkillUses,
              totalSkills,
            });
          },
          async resolveWorkspaceSlug(workspaceId) {
            const result = await control.pool.query<{ slug: string }>(
              "SELECT slug FROM workspaces WHERE id = $1 LIMIT 1",
              [workspaceId],
            );
            return result.rows[0]?.slug ?? null;
          },
        }).then(() => undefined),
      onEvent(event) {
        console.info(
          JSON.stringify({
            event: `public_projection.${event.type}`,
            regionId,
            eventId: event.eventId,
            ...(event.errorCode ? { errorCode: event.errorCode } : {}),
          }),
        );
      },
    }).then(async (result) => {
      await cleanupProjectionRetention({
        regionalDatabase: regional.pool,
        controlDatabase: control.pool,
      });
      return result;
    });
    const projected = await projection.then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const jobs = await drainBackgroundJobs({
      database: regional.pool,
      registry,
      workerId: `projection-${regionId}`,
      maxDurationMs: BACKGROUND_JOB_BUDGET_MS,
      onEvent(event) {
        console.info(
          JSON.stringify({
            event: `background_job.${event.type}`,
            regionId,
            jobId: event.jobId,
            ...(event.kind ? { kind: event.kind } : {}),
            ...(event.attempt ? { attempt: event.attempt } : {}),
          }),
        );
      },
    });
    if (!projected.ok) throw projected.error;
    return { ...projected.result, jobs };
  } finally {
    await Promise.allSettled([regional.close(), control.close()]);
  }
}

export default {
  scheduled(
    _controller: ScheduledController,
    bindings: ProjectionBindings,
    context: ExecutionContext,
  ) {
    context.waitUntil(drainProjectionCell(bindings).then(() => undefined));
  },
};
