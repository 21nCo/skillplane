import type { AuthFnSession } from "authfn";
import {
  createDatafnServer,
  datafnMultiRegionPlugin,
  type DatafnPlacementRuntimeConfig,
  type DatafnServer,
} from "@datafn/server";
import { resolveUserPrincipal, type DatabaseClient } from "@skillplane/db";
import type { Principal } from "@skillplane/domain";
import type { IndexedDirectoryStoreAdapter } from "@superfunctions/db";
import { DATAFN_RESOURCE_NAMES, skillplaneDatafnSchema } from "./schema.js";

export interface DatafnAuthProvider {
  authenticate(request: Request): Promise<AuthFnSession | null>;
}

export interface SkillplaneDatafnContext {
  readonly request: Request;
  readonly principal: Principal;
}

export interface CreateSkillplaneDatafnServerInput {
  readonly database: DatabaseClient;
  /** Global identity and membership authority; defaults to database in legacy mode. */
  readonly controlDatabase?: DatabaseClient;
  readonly auth: DatafnAuthProvider;
  readonly regionId?: string;
  readonly permissionDirectory?: IndexedDirectoryStoreAdapter;
  readonly placement?: DatafnPlacementRuntimeConfig;
  readonly trustDirectWorkspaceHeader?: boolean;
  readonly debug?: boolean;
  readonly onTiming?: (event: Readonly<Record<string, unknown>>) => void;
}

function requestedResources(payload: unknown, found = new Set<string>()): Set<string> {
  if (!payload || typeof payload !== "object") return found;
  if (Array.isArray(payload)) {
    for (const item of payload) requestedResources(item, found);
    return found;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.resource === "string") {
    found.add(record.resource);
  }
  if (Array.isArray(record.resources)) {
    for (const resource of record.resources) {
      if (typeof resource === "string") found.add(resource);
    }
  }
  for (const value of Object.values(record)) {
    if (typeof value === "object") requestedResources(value, found);
  }
  return found;
}

export async function createSkillplaneDatafnServer(
  input: CreateSkillplaneDatafnServerInput,
): Promise<DatafnServer<SkillplaneDatafnContext>> {
  const allowedResources = new Set<string>(DATAFN_RESOURCE_NAMES);
  const multiRegion =
    input.regionId && input.permissionDirectory
      ? datafnMultiRegionPlugin({
          regionId: input.regionId,
          directory: input.permissionDirectory,
          ...(input.placement ? { placement: input.placement } : {}),
        })
      : null;
  return createDatafnServer<SkillplaneDatafnContext>({
    schema: skillplaneDatafnSchema,
    database: input.database.adapter,
    ...(multiRegion ? { plugins: [multiRegion] } : {}),
    allowUnknownResources: false,
    debug: input.debug ?? false,
    rest: false,
    context: async (request) => {
      const session = await input.auth.authenticate(request);
      const routedWorkspaceId = request.headers.get("x-skillplane-routed-workspace-id");
      const workspaceId =
        routedWorkspaceId ??
        (input.trustDirectWorkspaceHeader === false
          ? undefined
          : (request.headers.get("x-skillplane-workspace-id") ?? undefined));
      const principal = await resolveUserPrincipal(
        (input.controlDatabase ?? input.database).pool,
        session,
        workspaceId,
      );
      return { request, principal };
    },
    authorize: (context, action, payload) => {
      if (!["status", "query", "search"].includes(action)) return false;
      const resources = requestedResources(payload);
      if (action !== "status" && resources.size === 0) return false;
      return [...resources].every((resource) => allowedResources.has(resource));
    },
    namespaceProvider: {
      getNamespace: (context) => context.principal.workspaceId,
      getActorId: (context) => context.principal.actorId,
    },
    rowLevelNamespace: {
      enabled: true,
      columnName: "workspaceId",
      mandatory: true,
    },
    limits: {
      maxLimit: 100,
      maxTransactSteps: 0,
      maxPayloadBytes: 256 * 1024,
      maxPullLimit: 0,
      maxSelectTokens: 40,
      maxFilterKeysPerLevel: 16,
      maxSortFields: 4,
      maxAggregations: 8,
      maxIdLength: 255,
      maxBatchSize: 1,
      maxBatchQueryConcurrency: 8,
    },
    rateLimit: {
      enabled: true,
      maxRequests: 120,
      windowSeconds: 60,
      endpoints: {
        query: { maxRequests: 120, windowSeconds: 60 },
      },
      keyExtractor: (context) =>
        `${context.principal.workspaceId}:${context.principal.actorId}`,
    },
    observability: {
      timing: true,
      ...(input.onTiming
        ? {
            onTiming: (event: unknown) =>
              input.onTiming?.(event as Readonly<Record<string, unknown>>),
          }
        : {}),
    },
  });
}
