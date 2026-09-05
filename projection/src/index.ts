import {
  PostgresPublicProjectionDirectory,
  applyPublicStatsProjectionCheckpoint,
  applyRegionalPublicProjection,
  cleanupProcessedRegionalProjectionOutbox,
  cleanupPublicStatsProjectionEvents,
  createImmutableObjectPublicationStore,
  createPostgresResourceRoutingDirectory,
  createPostgresWorkspacePlacementDirectory,
  drainRegionalProjectionOutbox,
} from "@skillplane/control-plane";
import {
  createControlDatabaseClient,
  createRegionalDatabaseClient,
} from "@skillplane/db";

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

function connectionString(value: HyperdriveBinding | undefined, name: string) {
  if (!value?.connectionString) throw new Error(`${name}_UNAVAILABLE`);
  return value.connectionString;
}

export async function drainProjectionCell(
  bindings: ProjectionBindings,
): Promise<{ readonly processed: number; readonly failed: number }> {
  const regionId = bindings.SKILLPLANE_REGION_ID.trim();
  if (!regionId) throw new Error("SKILLPLANE_REGION_ID_UNAVAILABLE");
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
    const result = await drainRegionalProjectionOutbox({
      regionId,
      database: regional.pool,
      limit: 100,
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
    });
    await Promise.all([
      cleanupProcessedRegionalProjectionOutbox({ database: regional.pool }),
      cleanupPublicStatsProjectionEvents({ database: control.pool }),
    ]);
    return result;
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
