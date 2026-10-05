import type { AuthFnSession } from "authfn";
import {
  createDatafnServer,
  datafnMultiRegionPlugin,
  routeTicketError,
  verifyDatafnRegionalTicketIdentity,
  type DatafnPlacementRuntimeConfig,
  type DatafnRegionalTicketRuntime,
  type DatafnServer,
} from "@datafn/server";
import {
  resolveUserPrincipal,
  resolveUserPrincipalByUserId,
  type DatabaseClient,
} from "@skillplane/db";
import type { Principal } from "@skillplane/domain";
import type {
  Adapter,
  FindManyParams,
  FindOneParams,
  IndexedDirectoryStoreAdapter,
} from "@superfunctions/db";
import { collectDatafnStructuralResources } from "./resource-selectors.js";
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
  /** Public regional requests derive identity from the verified ticket alone. */
  readonly routeTickets?: DatafnRegionalTicketRuntime;
  readonly trustDirectWorkspaceHeader?: boolean;
  readonly debug?: boolean;
  readonly onTiming?: (event: Readonly<Record<string, unknown>>) => void;
}

function normalizeRecordDates<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      field instanceof Date ? field.toISOString() : field,
    ]),
  ) as T;
}

/**
 * Keep database rows and JSON-round-tripped cursors comparable. Only direct
 * Date fields are normalized; nested JSON and relation arrays stay untouched.
 */
function createCursorStableReadAdapter(adapter: Adapter): Adapter {
  return {
    ...adapter,
    findOne: async <T = unknown>(params: FindOneParams) => {
      const record = await adapter.findOne<T>(params);
      return record ? normalizeRecordDates(record) : null;
    },
    findMany: async <T = unknown>(params: FindManyParams) =>
      (await adapter.findMany<T>(params)).map(normalizeRecordDates),
  };
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
    database: createCursorStableReadAdapter(input.database.adapter),
    ...(multiRegion ? { plugins: [multiRegion] } : {}),
    allowUnknownResources: false,
    debug: input.debug ?? false,
    rest: false,
    context: async (request) => {
      if (
        input.routeTickets &&
        input.regionId &&
        request.headers.has("x-datafn-route-ticket")
      ) {
        const claims = await verifyDatafnRegionalTicketIdentity({
          request,
          regionId: input.regionId,
          runtime: input.routeTickets,
        });
        const requestedWorkspace = request.headers.get("x-skillplane-workspace-id");
        if (requestedWorkspace && requestedWorkspace !== claims.namespace) {
          throw routeTicketError("DATAFN_ROUTE_TICKET_INVALID");
        }
        const principal = await resolveUserPrincipalByUserId(
          (input.controlDatabase ?? input.database).pool,
          claims.subject,
          claims.namespace,
        );
        return { request, principal };
      }
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
      const resources = collectDatafnStructuralResources(payload);
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
