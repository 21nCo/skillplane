import {
  AuthenticationRequiredError,
  DomainError,
  WorkspaceAccessError,
  authorize,
} from "@skillplane/domain";
import { writeAuditEvent } from "@skillplane/observability";
import type { WorkspaceAction } from "@skillplane/domain";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { ApiEnvironment } from "../context.js";
import { requestedWorkspaceId, resolveWorkspaceRequestContext } from "./context.js";

export function requiredAction(path: string, method: string): WorkspaceAction | null {
  const read = ["GET", "HEAD", "OPTIONS"].includes(method);
  if (/^\/api\/v1\/skills\/[^/]+\/amendments(?:\/|$)/u.test(path)) {
    return read ? "skills:read" : "skills:amend";
  }
  if (/^\/api\/v1\/skills\/[^/]+\/amendment-policy(?:\/|$)/u.test(path)) {
    return read ? "skills:read" : "skills:publish";
  }
  if (/^\/api\/v1\/skills\/[^/]+\/reviews\/[^/]+\/(?:approve|reject)$/u.test(path)) {
    return "skills:publish";
  }
  if (/^\/api\/v1\/skills\/[^/]+\/candidates(?:\/|$)/u.test(path)) {
    return "skills:read";
  }
  if (
    path.startsWith("/api/v1/contexts") ||
    path.startsWith("/api/v1/context-notes") ||
    /^\/api\/v1\/skills\/[^/]+\/contexts(?:\/|$)/u.test(path)
  ) {
    return read ? "contexts:read" : "contexts:write";
  }
  if (path.startsWith("/api/v1/skills")) {
    return read ? "skills:read" : "skills:write";
  }
  if (path.startsWith("/api/v1/analytics")) return "analytics:read";
  if (path.startsWith("/api/v1/audit")) return "audit:read";
  return null;
}

export function authorizationMiddleware(): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    context.set("principal", null);
    if (context.req.path.startsWith("/api/v1/workspaces") && !context.get("session")) {
      throw new AuthenticationRequiredError();
    }
    if (context.req.path.startsWith("/datafn/")) {
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
      const publicSkillRead =
        action === "skills:read" && !servicePrincipal && !requestedWorkspace;
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
        try {
          await writeAuditEvent(services.database.pool, {
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
