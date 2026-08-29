import type { PlacementSqlClient } from "./placement.js";

export type RoutableResourceType =
  "workspace" | "skill" | "skill_version" | "context" | "context_note";

export interface ResourceRoute {
  readonly resourceType: RoutableResourceType;
  readonly resourceId: string;
  readonly workspaceId: string;
  readonly state: "active" | "tombstoned";
  readonly updatedAt: string;
}

interface ResourceRouteRow extends Record<string, unknown> {
  readonly resource_type: RoutableResourceType;
  readonly resource_id: string;
  readonly workspace_id: string;
  readonly state: "active" | "tombstoned";
  readonly updated_at: Date | string;
}

export interface ResourceRoutingDirectory {
  resolve(
    resourceType: RoutableResourceType,
    resourceId: string,
  ): Promise<ResourceRoute | null>;
  upsert(route: Omit<ResourceRoute, "state" | "updatedAt">): Promise<void>;
  tombstone(resourceType: RoutableResourceType, resourceId: string): Promise<void>;
}

export function createPostgresResourceRoutingDirectory(
  sql: PlacementSqlClient,
): ResourceRoutingDirectory {
  return {
    async resolve(resourceType, resourceId) {
      const result = await sql.query<ResourceRouteRow>(
        `SELECT resource_type, resource_id, workspace_id, state, updated_at
           FROM resource_routing_directory
          WHERE resource_type = $1 AND resource_id = $2 AND state = 'active'`,
        [resourceType, resourceId],
      );
      const row = result.rows[0];
      return row
        ? {
            resourceType: row.resource_type,
            resourceId: row.resource_id,
            workspaceId: row.workspace_id,
            state: row.state,
            updatedAt: new Date(row.updated_at).toISOString(),
          }
        : null;
    },
    async upsert(route) {
      await sql.query(
        `INSERT INTO resource_routing_directory
           (resource_type, resource_id, workspace_id, state, updated_at)
         VALUES ($1, $2, $3, 'active', now())
         ON CONFLICT (resource_type, resource_id)
         DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
                       state = 'active', updated_at = now()`,
        [route.resourceType, route.resourceId, route.workspaceId],
      );
    },
    async tombstone(resourceType, resourceId) {
      await sql.query(
        `UPDATE resource_routing_directory
            SET state = 'tombstoned', updated_at = now()
          WHERE resource_type = $1 AND resource_id = $2`,
        [resourceType, resourceId],
      );
    },
  };
}
