import {
  AuthenticationRequiredError,
  DomainError,
  WorkspaceAccessError,
  authorize,
} from "@skillplane/domain";
import { PostgresAuditWriter } from "@skillplane/observability";
import type { WorkspaceAction } from "@skillplane/domain";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { ApiEnvironment } from "../context.js";
import { requestedWorkspaceId, resolveWorkspaceRequestContext } from "./context.js";
import { routingEpoch } from "../routes/shared.js";

const routeActions: readonly [RegExp, WorkspaceAction, WorkspaceAction][] = [
  [
    /^\/api\/v1\/skills\/[^/]+\/versions\/[^/]+\/repair-bundle$/u,
    "skills:write",
    "skills:write",
  ],
  [/^\/api\/v1\/skills\/[^/]+\/amendments(?:\/|$)/u, "skills:read", "skills:amend"],
  [
    /^\/api\/v1\/skills\/[^/]+\/amendment-policy(?:\/|$)/u,
    "skills:read",
    "skills:publish",
  ],
  [
    /^\/api\/v1\/skills\/[^/]+\/reviews\/[^/]+\/(?:approve|reject)$/u,
    "skills:publish",
    "skills:publish",
  ],
  [/^\/api\/v1\/skills\/[^/]+\/candidates(?:\/|$)/u, "skills:read", "skills:read"],
  [/^\/api\/v1\/(?:contexts|context-notes)/u, "contexts:read", "contexts:write"],
  [/^\/api\/v1\/skills\/[^/]+\/contexts(?:\/|$)/u, "contexts:read", "contexts:write"],
  [/^\/api\/v1\/skills/u, "skills:read", "skills:write"],
  [/^\/api\/v1\/analytics/u, "analytics:read", "analytics:read"],
  [/^\/api\/v1\/audit/u, "audit:read", "audit:read"],
];
export function requiredAction(path: string, method: string): WorkspaceAction | null {
  const read = ["GET", "HEAD", "OPTIONS"].includes(method);
  const match = routeActions.find(([pattern]) => pattern.test(path));
  if (!match) return null;
  return match[read ? 1 : 2];
}

export function authorizationMiddleware(): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    context.set("principal", null);
    if (context.req.path.startsWith("/api/v1/workspaces") && !context.get("session")) {
      throw new AuthenticationRequiredError();
    }
    if (context.req.path.startsWith("/datafn/")) {
      if (
        context.get("services")?.deploymentRole === "cell" &&
        context.req.header("x-datafn-route-ticket") !== undefined
      ) {
        // The DataFn context and placement plugin both verify the ticket.
        await next();
        return;
      }
      const principal = await resolveWorkspaceRequestContext(context);
      context.set("principal", principal);
      await next();
      return;
    }
    const action = requiredAction(context.req.path, context.req.method);
    if (action) {
      const explicitPublicSkillRead =
        action === "skills:read" &&
        context.req.path.startsWith("/api/v1/skills/public/");
      if (explicitPublicSkillRead) {
        await next();
        return;
      }
      const servicePrincipal = context.get("servicePrincipal");
      const requestedWorkspace = requestedWorkspaceId(context);
      const routedPublicSkillRead =
        action === "skills:read" &&
        context.req.header("x-skillplane-public-skill-read") === "1" &&
        /^\/api\/v1\/skills\/[^/]+\/versions(?:\/|$)/u.test(context.req.path);
      const publicSkillRead =
        action === "skills:read" &&
        !servicePrincipal &&
        (!requestedWorkspace || routedPublicSkillRead);
      if (publicSkillRead) {
        await next();
        return;
      }
      if (
        servicePrincipal &&
        requestedWorkspace &&
        requestedWorkspace !== servicePrincipal.workspaceId
      ) {
        throw new WorkspaceAccessError();
      }
      const principal =
        servicePrincipal ?? (await resolveWorkspaceRequestContext(context));
      try {
        authorize(principal, action);
      } catch (error) {
        const services = context.get("services");
        if (!services) throw error;
        const fencingEpoch = routingEpoch(context);
        try {
          await new PostgresAuditWriter(services.database.pool).record({
            workspaceId: principal.workspaceId,
            eventType: "authorization.denied",
            action,
            outcome: "denied",
            actorType: principal.kind === "user" ? "user" : "service_principal",
            actorId: principal.actorId,
            userId:
              principal.kind === "user"
                ? principal.userId
                : (principal.delegatedUserId ?? null),
            requestId: context.get("requestId"),
            resourceType: "workspace",
            resourceId: principal.workspaceId,
            channel: "app",
            retentionClass: "permanent",
            fencingEpoch,
            metadata: {
              method: context.req.method,
              requestedAction: action,
              route: routePath(context) || "unmatched",
            },
          });
        } catch {
          throw new DomainError(
            "AUDIT_WRITE_FAILED",
            "The authorization decision could not be recorded",
            503,
          );
        }
        throw error;
      }
      context.set("principal", principal);
    }
    await next();
  };
}
