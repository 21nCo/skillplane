import { createPostgresResourceRoutingDirectory } from "@skillplane/control-plane";
import type { RoutableResourceType } from "@skillplane/control-plane";
import type { ApiServices } from "./context.js";

/** Best-effort fast path; the regional outbox is the durable source of truth. */
export async function registerResourceRoutes(
  services: ApiServices,
  workspaceId: string,
  resources: readonly {
    readonly resourceType: RoutableResourceType;
    readonly resourceId: string;
  }[],
): Promise<void> {
  const directory = createPostgresResourceRoutingDirectory(
    services.controlDatabase.pool,
  );
  for (const resource of resources) {
    try {
      await directory.upsert({ ...resource, workspaceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN";
      console.warn(
        JSON.stringify({
          event: "resource_route.fast_path_failed",
          workspaceId,
          resourceType: resource.resourceType,
          errorCode: /^[A-Z0-9_:-]{1,160}$/u.test(message)
            ? message
            : "RESOURCE_ROUTE_FAST_PATH_FAILED",
        }),
      );
    }
  }
}
