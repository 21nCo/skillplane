import { createPostgresResourceRoutingDirectory } from "@skillplane/control-plane";
import type { RoutableResourceType } from "@skillplane/control-plane";
import type { ApiServices } from "./context.js";

/** Idempotently projects newly created regional IDs into the global router. */
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
    await directory.upsert({ ...resource, workspaceId });
  }
}
