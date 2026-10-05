import {
  CloudflareTurnstileVerifier,
  createSkillplaneAuthFnMultiRegionConfig,
  createPostgresOtpRateLimiter,
  createPostgresAuthFnPlacementDirectory,
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
import {
  createDatafnEd25519RouteTicketSigner,
  createDatafnEd25519RouteTicketVerifier,
  createDatafnRouteBootstrap,
  type DatafnNamespacePlacement,
  type DatafnRegionalTicketRuntime,
} from "@datafn/server";
import {
  consumeRateLimit,
  createDatabaseClient,
  resolveUserPrincipal,
} from "@skillplane/db";
import { createSkillplaneSendFn } from "@skillplane/email";
import {
  VersionLifecycleService,
  CompositionService,
  VerificationService,
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

function requireConfigured<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

export async function buildApiServices(
  bindings: RuntimeBindings,
  options: BuildApiServicesOptions = {},
): Promise<ApiServices> {
  const runtime = parseRuntimeConfig(bindings, options);
  const gatewayTickets =
    runtime.deployment.role === "gateway" && runtime.directDatafn.enabled
      ? {
          subjectSecret: requireConfigured(
            runtime.directDatafn.subjectSecret,
            "AUTHFN_PLACEMENT_SUBJECT_SECRET",
          ),
          activeKeyId: requireConfigured(
            runtime.directDatafn.activeKeyId,
            "DATAFN_ROUTE_ACTIVE_KEY_ID",
          ),
          privateKey: requireConfigured(
            runtime.directDatafn.privateKey,
            "DATAFN_ROUTE_PRIVATE_KEY_PEM",
          ),
        }
      : null;
  const cellTicketKeys =
    runtime.deployment.role === "cell" && runtime.directDatafn.enabled
      ? requireConfigured(runtime.directDatafn.publicKeys, "DATAFN_ROUTE_PUBLIC_KEYS")
      : null;
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
    const authPlacementDirectory = createPostgresAuthFnPlacementDirectory(
      controlDatabase.pool,
    );
    const auth = createSkillplaneAuthServer({
      database: controlDatabase,
      oauth: {
        issuer: runtime.oauth.issuer,
        resource: runtime.oauth.resource,
        tokenPepper: runtime.oauth.tokenPepper,
      },
      ...(!single
        ? {
            multiRegion: createSkillplaneAuthFnMultiRegionConfig({
              issuer: runtime.oauth.issuer,
              resource: runtime.oauth.resource,
            }),
          }
        : {}),
      ...(gatewayTickets
        ? {
            placementContext: {
              regionId: runtime.deployment.topology.controlPlane.regionId,
              subjectSecret: gatewayTickets.subjectSecret,
              directory: authPlacementDirectory,
              identityKeyForUserId: (userId: string) => `user:${userId}`,
            },
          }
        : {}),
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
    const regionalEndpoint = runtime.deployment.topology.cells.find(
      (cell) => cell.regionId === runtime.deployment.regionId,
    )?.datafnEndpoint;
    const routeTickets: DatafnRegionalTicketRuntime | undefined =
      runtime.deployment.role === "cell" && cellTicketKeys && regionalEndpoint
        ? {
            verifier: createDatafnEd25519RouteTicketVerifier({
              publicKeys: { ...cellTicketKeys },
            }),
            issuer: runtime.oauth.issuer,
            audience: regionalEndpoint.audience,
            allowedOrigins: [runtime.oauth.issuer],
            allowRequest: async (claims) =>
              (
                await consumeRateLimit(
                  controlDatabase.pool,
                  `datafn-direct:${claims.namespace}:${claims.subject}`,
                  120,
                  60,
                )
              ).allowed,
            onEvent: (event) =>
              console.info(
                JSON.stringify({
                  event: "datafn.ticket",
                  ...event,
                  regionId: runtime.deployment.regionId,
                }),
              ),
          }
        : undefined;
    const datafnSigner = gatewayTickets
      ? createDatafnEd25519RouteTicketSigner({
          activeKeyId: gatewayTickets.activeKeyId,
          privateKey: gatewayTickets.privateKey,
        })
      : null;
    const datafnBootstrap = datafnSigner
      ? async (request: Request) => {
          const observed: { placement: DatafnNamespacePlacement | null } = {
            placement: null,
          };
          const issue = createDatafnRouteBootstrap({
            directory: {
              ...placementDirectory,
              get: async (namespace) => {
                observed.placement = await placementDirectory.get(namespace);
                return observed.placement;
              },
            },
            signer: datafnSigner,
            issuer: runtime.oauth.issuer,
            ttlMs: 60_000,
            authenticate: async (request) => {
              const workspaceId =
                request.headers.get("x-skillplane-workspace-id") ?? undefined;
              if (
                !workspaceId ||
                !(
                  runtime.directDatafn.workspaceIds.includes("*") ||
                  runtime.directDatafn.workspaceIds.includes(workspaceId)
                )
              )
                throw new Error("DATAFN_DIRECT_DISABLED");
              const session = await auth.provider.authenticate(request);
              if (!session) throw new Error("AUTHENTICATION_REQUIRED");
              await resolveUserPrincipal(controlDatabase.pool, session, workspaceId);
              const identityKey = `user:${session.actorId}`;
              await authPlacementDirectory.putIfAbsent({
                identityKey,
                regionId: runtime.deployment.topology.controlPlane.regionId,
                epoch: 1,
                state: "active",
                updatedAt: new Date(),
              });
              if (!auth.derivePlacementContext)
                throw new Error("DATAFN_AUTH_CONTEXT_UNAVAILABLE");
              const context = await auth.derivePlacementContext(request);
              if (context.actorType !== "user" || context.userId !== session.actorId) {
                throw new Error("DATAFN_AUTH_CONTEXT_INVALID");
              }
              return {
                subject: context.userId,
                namespace: workspaceId,
                sessionBinding: context.sessionBinding,
                expiresAt: Date.parse(context.expiresAt),
              };
            },
            authorize: () => ["query", "search"],
            resolveEndpoint: (placement) => {
              const endpoint = runtime.deployment.topology.cells.find(
                (cell) => cell.regionId === placement.regionId,
              )?.datafnEndpoint;
              if (!endpoint) throw new Error("DATAFN_ENDPOINT_UNAVAILABLE");
              // The current Skillplane DataFn schema is read only and does not
              // admit WebSocket sync. Do not advertise an unusable WS route.
              return { httpUrl: endpoint.httpUrl, audience: endpoint.audience };
            },
            onEvent: (event) =>
              console.info(JSON.stringify({ event: "datafn.bootstrap", ...event })),
          });
          const response = await issue(request);
          if (!response.ok || !observed.placement) return response;
          const descriptor = (await response.json()) as Record<string, unknown>;
          return Response.json(
            { ...descriptor, regionEpoch: observed.placement.epoch },
            { headers: response.headers },
          );
        }
      : null;
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
              ...(routeTickets ? { routeTickets } : {}),
              assertionVerifier: assertions,
              replayStore: createPostgresRoutingReplayStore(controlDatabase.pool),
              assertionAudience: runtime.routing.audience,
              onEvent: (event) => logWorkspaceRoutingEvent("datafn", event),
            },
            trustDirectWorkspaceHeader: false,
            ...(routeTickets ? { routeTickets } : {}),
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
    const compositionService = new CompositionService(
      database.pool,
      bundleStorage,
      controlDatabase.pool,
      publicBundleStorage ?? bundleStorage,
      false,
      bindings.SKILL_COMPOSITION_WRITES_ENABLED === "true",
    );
    const skillService = new SkillService(
      database.pool,
      bundleStorage,
      controlDatabase.pool,
      compositionService,
    );
    const contextService = new ContextService(database.pool, skillService.idempotency);
    const amendmentPolicyService = new AmendmentPolicyService(
      database.pool,
      skillService.idempotency,
      controlDatabase.pool,
    );
    return {
      database,
      controlDatabase,
      workspaceRegions: runtime.deployment.topology.cells.map((cell) => cell.regionId),
      workspaceRegionCandidates: runtime.deployment.topology.cells.map((cell) => ({
        regionId: cell.regionId,
        displayName: cell.placement?.displayName ?? cell.regionId,
        ...(cell.placement
          ? {
              latitude: cell.placement.latitude,
              longitude: cell.placement.longitude,
            }
          : {}),
      })),
      deploymentRole: runtime.deployment.role,
      auth,
      datafn,
      datafnBootstrap,
      email,
      tenancySecret,
      bundleStorage,
      publicProjectionService:
        runtime.deployment.role === "gateway" || runtime.deployment.role === "control"
          ? new PublicSkillProjectionService(
              controlDatabase.pool,
              publicBundleStorage ?? bundleStorage,
              tenancySecret,
            )
          : null,
      skillService,
      compositionService,
      versionLifecycleService: new VersionLifecycleService(
        database.pool,
        controlDatabase.pool,
        skillService.idempotency,
      ),
      verificationService: new VerificationService(
        database.pool,
        compositionService,
        skillService.idempotency,
      ),
      amendmentService: new AmendmentService(
        database.pool,
        bundleStorage,
        skillService.idempotency,
        controlDatabase.pool,
        compositionService,
      ),
      amendmentPolicyService,
      amendmentReviewService: new AmendmentReviewService(
        database.pool,
        bundleStorage,
        skillService.idempotency,
        compositionService,
      ),
      skillVersionService: new SkillVersionService(
        database.pool,
        bundleStorage,
        skillService.idempotency,
        compositionService,
      ),
      publicationService: new PublicationService(
        database.pool,
        bundleStorage,
        skillService.idempotency,
        compositionService,
      ),
      skillSearchService: new SkillSearchService(
        database.pool,
        tenancySecret,
        controlDatabase.pool,
      ),
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
  build: typeof buildApiServices = buildApiServices,
): ApiServiceProvider {
  return Object.assign((bindings: RuntimeBindings) => build(bindings, options), {
    release: closeApiServices,
  });
}
