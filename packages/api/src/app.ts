import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { ApiEnvironment, ApiServiceProvider } from "./context.js";
import { failure, success } from "./envelopes.js";
import { toApiError } from "./errors.js";
import { createReadinessProbe, type ReadinessProbe } from "./health.js";
import { authenticationMiddleware } from "./middleware/authentication.js";
import { authorizationMiddleware } from "./middleware/authorization.js";
import { observabilityMiddleware } from "./middleware/observability.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { securityMiddleware } from "./middleware/security.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerAmendmentRoutes } from "./routes/amendments.js";
import { registerContextNoteRoutes } from "./routes/context-notes.js";
import { registerContextRoutes } from "./routes/contexts.js";
import { registerServicePrincipalRoutes } from "./routes/service-principals.js";
import { registerSkillRoutes } from "./routes/skills.js";
import { registerSkillSearchRoutes } from "./routes/search.js";
import { registerSkillVersionRoutes } from "./routes/skill-versions.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerOAuthMetadataRoutes } from "./routes/oauth-metadata.js";
import { registerPublicStatsRoutes } from "./routes/public-stats.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerAuditRoutes } from "./routes/audit.js";

export const MIDDLEWARE_ORDER = [
  "request-id",
  "security-headers",
  "authentication",
  "authorization",
  "rate-limit",
  "observability",
] as const;

type MiddlewareName = (typeof MIDDLEWARE_ORDER)[number];

export interface ApiOptions {
  readonly serviceName?: string;
  readonly readiness?: ReadinessProbe;
  readonly requestId?: () => string;
  readonly now?: () => Date;
  readonly getServices?: ApiServiceProvider;
  readonly middlewareObserver?: (name: MiddlewareName) => void;
  readonly oauthMetadata?: {
    readonly issuer: string;
    readonly resource: string;
  };
}

function observe(
  name: MiddlewareName,
  middleware: MiddlewareHandler<ApiEnvironment>,
  observer?: (name: MiddlewareName) => void,
): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    observer?.(name);
    return middleware(context, next);
  };
}

export function createApiApp(options: ApiOptions = {}) {
  const app = new Hono<ApiEnvironment>();
  const serviceName = options.serviceName ?? "skillplane-app";
  const readiness = options.readiness ?? createReadinessProbe();
  const createRequestId = options.requestId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());

  app.use(
    "*",
    observe(
      "request-id",
      requestIdMiddleware(createRequestId),
      options.middlewareObserver,
    ),
  );
  app.use(
    "*",
    observe("security-headers", securityMiddleware(), options.middlewareObserver),
  );
  app.use(
    "*",
    observe(
      "authentication",
      authenticationMiddleware(options.getServices),
      options.middlewareObserver,
    ),
  );
  app.use(
    "*",
    observe("authorization", authorizationMiddleware(), options.middlewareObserver),
  );
  app.use(
    "*",
    observe("rate-limit", rateLimitMiddleware(), options.middlewareObserver),
  );
  app.use(
    "*",
    observe("observability", observabilityMiddleware(), options.middlewareObserver),
  );

  app.get("/api/v1/health/live", (context) =>
    context.json(
      success(context, {
        service: serviceName,
        status: "live",
        checkedAt: now().toISOString(),
      }),
    ),
  );

  app.get("/api/v1/health/ready", async (context) => {
    const result = await readiness(context.env);
    return context.json(
      success(context, {
        service: serviceName,
        status: result.ok ? "ready" : "not-ready",
        checkedAt: now().toISOString(),
        checks: result.checks,
      }),
      result.ok ? 200 : 503,
    );
  });

  registerOAuthMetadataRoutes(app, options.oauthMetadata);
  registerPublicStatsRoutes(app);
  registerAnalyticsRoutes(app);
  registerAuditRoutes(app);
  registerWorkspaceRoutes(app);
  registerInvitationRoutes(app);
  registerServicePrincipalRoutes(app);
  registerSkillSearchRoutes(app);
  registerSkillRoutes(app);
  registerSkillVersionRoutes(app);
  registerAmendmentRoutes(app);
  registerReviewRoutes(app);
  registerContextRoutes(app);
  registerContextNoteRoutes(app);

  app.all("/auth/*", async (context) => {
    const services = context.get("services");
    if (!services) {
      return context.json(
        failure(context, "SERVICE_UNAVAILABLE", "Authentication is unavailable"),
        503,
      );
    }
    return services.auth.handle(context.req.raw);
  });

  app.all("/datafn/*", async (context) => {
    const services = context.get("services");
    if (!services) {
      return context.json(
        failure(context, "SERVICE_UNAVAILABLE", "Data access is unavailable"),
        503,
      );
    }
    return services.datafn.router.handle(context.req.raw);
  });

  app.notFound((context) =>
    context.json(
      failure(context, "ROUTE_NOT_FOUND", "The requested API route does not exist"),
      404,
    ),
  );

  app.onError((error, context) => {
    const response = toApiError(context, error);
    return context.json(response.body, response.status);
  });

  return app;
}
