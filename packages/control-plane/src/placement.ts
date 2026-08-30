import {
  claimDatafnNamespacePlacement,
  createDatafnHmacRoutingAssertions,
  createMemoryDatafnPlacementDirectory,
  type DatafnNamespacePlacement,
  type DatafnPlacementDirectoryAdapter,
  type DatafnPlacementState,
  type DatafnRoutingAssertionSigner,
  type DatafnRoutingAssertionVerifier,
} from "@datafn/server";

export type WorkspacePlacement = DatafnNamespacePlacement;
export type WorkspacePlacementState = DatafnPlacementState;
export type WorkspacePlacementDirectory = DatafnPlacementDirectoryAdapter;
export type WorkspaceRoutingAssertionSigner = DatafnRoutingAssertionSigner;
export type WorkspaceRoutingAssertionVerifier = DatafnRoutingAssertionVerifier;

interface QueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PlacementSqlClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

interface PlacementRow extends Record<string, unknown> {
  readonly workspace_id: string;
  readonly region_id: string;
  readonly epoch: number | string;
  readonly state: WorkspacePlacementState;
  readonly updated_at: Date | string;
  readonly cache_expires_at: Date | string | null;
  readonly destination_ref: string | null;
  readonly moving_to_region_id: string | null;
  readonly previous_region_id: string | null;
  readonly migration: WorkspacePlacement["migration"] | null;
}

function placement(row: PlacementRow): WorkspacePlacement {
  const epoch = Number(row.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("WORKSPACE_PLACEMENT_EPOCH_INVALID");
  }
  return {
    namespace: row.workspace_id,
    regionId: row.region_id,
    epoch,
    state: row.state,
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.cache_expires_at
      ? { cacheExpiresAt: new Date(row.cache_expires_at).toISOString() }
      : {}),
    ...(row.destination_ref ? { destinationRef: row.destination_ref } : {}),
    ...(row.moving_to_region_id ? { movingToRegionId: row.moving_to_region_id } : {}),
    ...(row.previous_region_id ? { previousRegionId: row.previous_region_id } : {}),
    ...(row.migration ? { migration: row.migration } : {}),
  };
}

const SELECT_PLACEMENT = `SELECT workspace_id, region_id, epoch, state, updated_at,
       cache_expires_at, destination_ref, moving_to_region_id,
       previous_region_id, migration
  FROM workspace_placements`;

function values(next: WorkspacePlacement): readonly unknown[] {
  return [
    next.namespace,
    next.regionId,
    next.epoch,
    next.state,
    next.updatedAt,
    next.cacheExpiresAt ?? null,
    next.destinationRef ?? null,
    next.movingToRegionId ?? null,
    next.previousRegionId ?? null,
    next.migration ? JSON.stringify(next.migration) : null,
  ];
}

/** PostgreSQL is the linearizable global authority for workspace placement. */
export function createPostgresWorkspacePlacementDirectory(
  sql: PlacementSqlClient,
): WorkspacePlacementDirectory {
  const get = async (namespace: string): Promise<WorkspacePlacement | null> => {
    const result = await sql.query<PlacementRow>(
      `${SELECT_PLACEMENT} WHERE workspace_id = $1`,
      [namespace],
    );
    const row = result.rows[0];
    return row ? placement(row) : null;
  };
  return {
    get,
    async putIfAbsent(next) {
      const result = await sql.query<PlacementRow>(
        `INSERT INTO workspace_placements
           (workspace_id, region_id, epoch, state, updated_at, cache_expires_at,
            destination_ref, moving_to_region_id, previous_region_id, migration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (workspace_id) DO NOTHING
         RETURNING workspace_id, region_id, epoch, state, updated_at,
                   cache_expires_at, destination_ref, moving_to_region_id,
                   previous_region_id, migration`,
        values(next),
      );
      const inserted = result.rows[0];
      if (inserted) return { inserted: true, placement: placement(inserted) };
      const existing = await get(next.namespace);
      if (!existing) throw new Error("WORKSPACE_PLACEMENT_WRITE_AMBIGUOUS");
      return { inserted: false, placement: existing };
    },
    async compareAndSet(input) {
      if (input.next.namespace !== input.namespace) {
        throw new Error("WORKSPACE_PLACEMENT_NAMESPACE_IMMUTABLE");
      }
      if (input.next.epoch <= input.expectedEpoch) {
        throw new Error("WORKSPACE_PLACEMENT_EPOCH_NON_MONOTONIC");
      }
      const expectedState = input.expectedState ?? null;
      const result = await sql.query<PlacementRow>(
        `UPDATE workspace_placements
            SET region_id = $2, epoch = $3, state = $4, updated_at = $5,
                cache_expires_at = $6, destination_ref = $7,
                moving_to_region_id = $8, previous_region_id = $9,
                migration = $10::jsonb
          WHERE workspace_id = $1 AND epoch = $11
            AND ($12::text IS NULL OR state = $12)
          RETURNING workspace_id, region_id, epoch, state, updated_at,
                    cache_expires_at, destination_ref, moving_to_region_id,
                    previous_region_id, migration`,
        [...values(input.next), input.expectedEpoch, expectedState],
      );
      const updated = result.rows[0];
      if (updated) return { updated: true, placement: placement(updated) };
      const existing = await get(input.namespace);
      return { updated: false, placement: existing ?? input.next };
    },
  };
}

export const createMemoryWorkspacePlacementDirectory =
  createMemoryDatafnPlacementDirectory;

export async function claimWorkspacePlacement(input: {
  readonly directory: WorkspacePlacementDirectory;
  readonly workspaceId: string;
  readonly regionId: string;
  readonly destinationRef?: string;
  readonly now?: () => number;
}): Promise<{ readonly claimed: boolean; readonly placement: WorkspacePlacement }> {
  return claimDatafnNamespacePlacement({
    directory: input.directory,
    namespace: input.workspaceId,
    regionId: input.regionId,
    ...(input.destinationRef ? { destinationRef: input.destinationRef } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

export function createWorkspaceRoutingAssertions(input: {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string | Uint8Array>>;
  readonly now?: () => number;
  readonly clockSkewMs?: number;
}): WorkspaceRoutingAssertionSigner & WorkspaceRoutingAssertionVerifier {
  return createDatafnHmacRoutingAssertions({
    activeKeyId: input.activeKeyId,
    keys: { ...input.keys },
    ...(input.now ? { now: input.now } : {}),
    ...(input.clockSkewMs === undefined ? {} : { clockSkewMs: input.clockSkewMs }),
  });
}

/** Stable fallback placement policy; deployments may override it with latency policy. */
export function selectInitialWorkspaceRegion(
  workspaceKey: string,
  regionIds: readonly string[],
): string {
  const regions = [...new Set(regionIds)].sort();
  if (regions.length === 0) throw new Error("WORKSPACE_REGION_UNAVAILABLE");
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(workspaceKey)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  const selected = regions[hash % regions.length];
  if (!selected) throw new Error("WORKSPACE_REGION_UNAVAILABLE");
  return selected;
}
