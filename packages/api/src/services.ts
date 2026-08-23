import {
  CloudflareTurnstileVerifier,
  createPostgresOtpRateLimiter,
  createSkillplaneAuthServer,
} from "@skillplane/auth";
import { parseRuntimeConfig, type RuntimeBindings } from "@skillplane/config";
import { createSkillplaneDatafnServer } from "@skillplane/datafn";
import { createRuntimeDatabaseClient } from "@skillplane/db";
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

export interface BuildApiServicesOptions {
  readonly authentication?: "full" | "oauth-only";
}

export async function buildApiServices(
  bindings: RuntimeBindings,
  options: BuildApiServicesOptions = {},
): Promise<ApiServices> {
  const runtime = parseRuntimeConfig(bindings, options);
  const database = createRuntimeDatabaseClient(runtime);
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
      database,
      oauth: {
        issuer: runtime.oauth.issuer,
        resource: runtime.oauth.resource,
        tokenPepper: runtime.oauth.tokenPepper,
      },
      ...(email ? { delivery: email.delivery } : {}),
      ...(runtime.auth
        ? {
            rateLimiter: createPostgresOtpRateLimiter({
              pool: database.pool,
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
    const datafn = await createSkillplaneDatafnServer({
      database,
      auth: auth.provider,
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
        : `skillplane-local-tenancy:${runtime.database.connectionString}`);
    const workerCaches = (
      globalThis as unknown as {
        readonly caches?: { readonly default?: R2DigestCacheLike };
      }
    ).caches;
    const bundleStorage = new R2BundleRepository(
      runtime.objectStorage as R2BucketLike,
      workerCaches?.default,
    );
    const skillService = new SkillService(database.pool, bundleStorage);
    const contextService = new ContextService(database.pool, skillService.idempotency);
    const amendmentPolicyService = new AmendmentPolicyService(
      database.pool,
      skillService.idempotency,
    );
    return {
      database,
      auth,
      datafn,
      email,
      tenancySecret,
      bundleStorage,
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
    await database.close();
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
  await close(() => services.database.close());

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
