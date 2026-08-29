import {
  CloudflareTurnstileVerifier,
  createPostgresOtpRateLimiter,
  createSkillplaneAuthServer,
} from "@skillplane/auth";
import { parseRuntimeConfig, type RuntimeBindings } from "@skillplane/config";
import {
  createPostgresPermissionDirectory,
  createPostgresRoutingReplayStore,
  createPostgresWorkspacePlacementDirectory,
  createWorkspaceRoutingAssertions,
  logWorkspaceRoutingEvent,
} from "@skillplane/control-plane";
import { createSkillplaneDatafnServer } from "@skillplane/datafn";
import { createDatabaseClient } from "@skillplane/db";
import { createSkillplaneSendFn } from "@skillplane/email";
import {
  AmendmentPolicyService,
  AmendmentReviewService,
  AmendmentService,
  ContextKnowledgeService,
  ContextNoteService,
  ContextService,
  PublicationService,
  SkillSearchService,
  SkillService,
  SkillVersionService,
} from "@skillplane/domain";
import {
  R2BundleRepository,
  type R2BucketLike,
  type R2DigestCacheLike,
} from "@skillplane/storage";
import type { ApiServiceProvider, ApiServices } from "./context.js";
import { PublicSkillProjectionService } from "./public-projections.js";

export interface BuildApiServicesOptions {
  readonly authentication?: "full" | "oauth-only";
}

export async function buildApiServices(
  bindings: RuntimeBindings,
  options: BuildApiServicesOptions = {},
): Promise<ApiServices> {
  const runtime = parseRuntimeConfig(bindings, options);
  const single = runtime.deployment.role === "single";
  const controlDatabase = createDatabaseClient({
    connectionString: runtime.controlDatabase.connectionString,
    applicationName: `skillplane-${runtime.environment}-control`,
    maxConnections: runtime.controlDatabase.source === "hyperdrive" ? 5 : 10,
    role: single ? "combined" : "control",
  });
  const database = runtime.regionalDatabase
    ? single
      ? controlDatabase
      : createDatabaseClient({
          connectionString: runtime.regionalDatabase.connectionString,
          applicationName: `skillplane-${runtime.environment}-${runtime.deployment.regionId ?? "cell"}`,
          maxConnections: runtime.regionalDatabase.source === "hyperdrive" ? 5 : 10,
          role: "regional",
        })
    : controlDatabase;
  const email = runtime.email
    ? createSkillplaneSendFn({
        binding: runtime.email.binding,
        from: runtime.email.from,
        environment: runtime.environment,
        signInUrl: runtime.oauth.issuer,
      })
    : null;
  try {
    const auth = createSkillplaneAuthServer({
      database: controlDatabase,
      oauth: {
        issuer: runtime.oauth.issuer,
        resource: runtime.oauth.resource,
        tokenPepper: runtime.oauth.tokenPepper,
      },
      ...(email ? { delivery: email.delivery } : {}),
      ...(runtime.auth
        ? {
            rateLimiter: createPostgresOtpRateLimiter({
              pool: controlDatabase.pool,
              pepper: runtime.auth.rateLimitPepper,
            }),
            turnstile: new CloudflareTurnstileVerifier({
              secretKey: runtime.auth.turnstile.secretKey,
              expectedAction: runtime.auth.turnstile.action,
              allowedHostnames: runtime.auth.turnstile.allowedHostnames,
              allowTestingKeyResponse: runtime.environment === "local",
            }),
          }
        : {}),
    });
    const assertions = createWorkspaceRoutingAssertions({
      activeKeyId: runtime.routing.activeKeyId,
      keys: runtime.routing.keys,
    });
    const placementDirectory = createPostgresWorkspacePlacementDirectory(
      controlDatabase.pool,
    );
    const datafn = await createSkillplaneDatafnServer({
      database,
      controlDatabase,
      auth: auth.provider,
      ...(runtime.deployment.role === "cell" && runtime.deployment.regionId
        ? {
            regionId: runtime.deployment.regionId,
            permissionDirectory: createPostgresPermissionDirectory(
              controlDatabase.pool,
            ),
            placement: {
              directory: placementDirectory,
              requireRoutingAssertion: true,
              assertionVerifier: assertions,
              replayStore: createPostgresRoutingReplayStore(controlDatabase.pool),
              assertionAudience: runtime.routing.audience,
              onEvent: (event) => logWorkspaceRoutingEvent("datafn", event),
            },
            trustDirectWorkspaceHeader: false,
          }
        : {}),
      debug: runtime.environment === "local",
      onTiming: (event) => {
        const phases =
          event.phases &&
          typeof event.phases === "object" &&
          !Array.isArray(event.phases)
            ? Object.fromEntries(
                Object.entries(event.phases)
                  .filter(
                    ([key, value]) =>
                      /^[a-z][a-z0-9_-]{0,63}$/iu.test(key) &&
                      typeof value === "number" &&
                      Number.isFinite(value),
                  )
                  .slice(0, 32),
              )
            : {};
        console.info(
          JSON.stringify({
            event: "datafn.timing",
            endpoint:
              typeof event.endpoint === "string"
                ? event.endpoint.slice(0, 128)
                : "unknown",
            ...(typeof event.resource === "string"
              ? { resource: event.resource.slice(0, 128) }
              : {}),
            ...(typeof event.operation === "string"
              ? { operation: event.operation.slice(0, 128) }
              : {}),
            phases,
            totalMs:
              typeof event.totalMs === "number" && Number.isFinite(event.totalMs)
                ? Math.max(0, event.totalMs)
                : 0,
            timestamp:
              typeof event.timestamp === "string"
                ? event.timestamp.slice(0, 64)
                : new Date().toISOString(),
          }),
        );
      },
    });
    const tenancySecret =
      runtime.secrets.authfn ??
      (options.authentication === "oauth-only"
        ? runtime.oauth.tokenPepper
        : `skillplane-local-tenancy:${runtime.controlDatabase.connectionString}`);
    const workerCaches = (
      globalThis as unknown as {
        readonly caches?: { readonly default?: R2DigestCacheLike };
      }
    ).caches;
    const bundleStorage = new R2BundleRepository(
      (runtime.regionalObjectStorage ??
        runtime.publicObjectStorage ??
        runtime.objectStorage) as R2BucketLike,
      workerCaches?.default,
    );
    const publicBundleStorage = runtime.publicObjectStorage
      ? new R2BundleRepository(
          runtime.publicObjectStorage as R2BucketLike,
          workerCaches?.default,
        )
      : null;
    const skillService = new SkillService(database.pool, bundleStorage);
    const contextService = new ContextService(database.pool, skillService.idempotency);
    const amendmentPolicyService = new AmendmentPolicyService(
      database.pool,
      skillService.idempotency,
    );
    return {
      database,
      controlDatabase,
      workspaceRegions: runtime.deployment.topology.cells.map((cell) => cell.regionId),
      deploymentRole: runtime.deployment.role,
      auth,
      datafn,
      email,
      tenancySecret,
      bundleStorage,
      publicProjectionService:
        runtime.deployment.role === "gateway" || runtime.deployment.role === "control"
          ? new PublicSkillProjectionService(
              controlDatabase.pool,
              publicBundleStorage ?? bundleStorage,
            )
          : null,
      skillService,
      amendmentService: new AmendmentService(
        database.pool,
        bundleStorage,
        skillService.idempotency,
      ),
      amendmentPolicyService,
      amendmentReviewService: new AmendmentReviewService(
        database.pool,
        bundleStorage,
        skillService.idempotency,
      ),
      skillVersionService: new SkillVersionService(
        database.pool,
        bundleStorage,
        skillService.idempotency,
      ),
      publicationService: new PublicationService(
        database.pool,
        bundleStorage,
        skillService.idempotency,
      ),
      skillSearchService: new SkillSearchService(database.pool, tenancySecret),
      contextService,
      contextKnowledgeService: new ContextKnowledgeService(
        database.pool,
        skillService.idempotency,
      ),
      contextNoteService: new ContextNoteService(
        database.pool,
        skillService.idempotency,
      ),
    };
  } catch (error) {
    await email?.close();
    if (database !== controlDatabase) await database.close();
    await controlDatabase.close();
    throw error;
  }
}

export async function closeApiServices(services: ApiServices): Promise<void> {
  let firstError: unknown;
  const close = async (operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      firstError ??= error;
    }
  };

  await close(() => services.datafn.close());
  const email = services.email;
  if (email) {
    await close(() => email.close());
  }
  if (services.database !== services.controlDatabase) {
    await close(() => services.database.close());
  }
  await close(() => services.controlDatabase.close());

  if (firstError instanceof Error) throw firstError;
  if (firstError !== undefined) {
    throw new Error("API service cleanup failed", { cause: firstError });
  }
}

export function createApiServiceProvider(
  options: BuildApiServicesOptions = {},
): ApiServiceProvider {
  return Object.assign(
    (bindings: RuntimeBindings) => buildApiServices(bindings, options),
    { release: closeApiServices },
  );
}
