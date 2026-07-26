import type { AuthFnSession } from "@authfn/core";
import { createDatafnServer, type DatafnServer } from "@datafn/server";
import { resolveUserPrincipal, type DatabaseClient } from "@skillplane/db";
import type { Principal } from "@skillplane/domain";
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
  readonly auth: DatafnAuthProvider;
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
  return createDatafnServer<SkillplaneDatafnContext>({
    schema: skillplaneDatafnSchema,
    db: input.database.adapter,
    allowUnknownResources: false,
    debug: input.debug ?? false,
    rest: false,
    context: async (request) => {
      const session = await input.auth.authenticate(request);
      const workspaceId = request.headers.get("x-skillplane-workspace-id") ?? undefined;
      const principal = await resolveUserPrincipal(
        input.database.pool,
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
    logger: {
      info: () => undefined,
      warn: () =>
        console.warn(
          JSON.stringify({
            component: "datafn",
            level: "warn",
            event: "datafn.warning",
          }),
        ),
      error: () =>
        console.error(
          JSON.stringify({
            component: "datafn",
            level: "error",
            event: "datafn.error",
          }),
        ),
      debug: () => undefined,
    },
  });
}
