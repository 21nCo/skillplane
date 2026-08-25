import {
  authenticateApiKey,
  authFnApiKeyPlugin,
  authFnEmailOtpPlugin,
  createApiKey,
  createAuthFn,
  revokeApiKeyById,
  type AuthFnConfig,
  type AuthFnDeliveryProvider,
  type AuthFnEvent,
  type AuthFnInstance,
  type AuthFnSession,
} from "@authfn/core";
import type { DatabaseClient } from "@skillplane/db";
import { createAuthApplication } from "./app.js";
import type { OtpRateLimiter } from "./rate-limit.js";
import { AUTH_COOKIE_CONFIG } from "./session.js";
import type { TurnstileVerifier } from "./turnstile.js";
import {
  createSkillplaneOAuth,
  type AuthFnMcpOAuthConfig,
  type OAuthRuntime,
} from "./oauth.js";

export interface SafeAuthEvent {
  readonly type: string;
  readonly requestId: string;
  readonly outcome?: string;
  readonly actorId?: string;
  readonly sessionId?: string;
  readonly clientId?: string;
}

export interface CreateSkillplaneAuthServerInput {
  readonly database: DatabaseClient;
  readonly delivery?: AuthFnDeliveryProvider;
  readonly rateLimiter?: OtpRateLimiter;
  readonly turnstile?: TurnstileVerifier;
  readonly codeGenerator?: () => string;
  readonly now?: () => Date;
  readonly emit?: (event: SafeAuthEvent) => Promise<void> | void;
  readonly oauth: Omit<AuthFnMcpOAuthConfig, "pool">;
}

export interface SkillplaneAuthServer {
  readonly authfn: AuthFnInstance;
  readonly provider: AuthFnInstance["provider"];
  readonly oauth: OAuthRuntime;
  readonly apiKeys: {
    create(input: {
      readonly ownerUserId: string;
      readonly name: string;
      readonly scopes: readonly string[];
      readonly metadata: Readonly<Record<string, unknown>>;
      readonly expiresAt: Date | null;
      readonly requestId: string;
    }): Promise<{ readonly keyId: string; readonly secret: string }>;
    authenticate(secret: string): Promise<AuthFnSession | null>;
    revoke(input: {
      readonly keyId: string;
      readonly actorId: string;
      readonly requestId: string;
    }): Promise<void>;
  };
  handle(request: Request): Promise<Response>;
  getSchema(): ReturnType<AuthFnInstance["getSchema"]>;
}

function safeEvent(event: AuthFnEvent): SafeAuthEvent {
  return {
    type: event.type,
    requestId: event.requestId,
    ...(event.outcome ? { outcome: event.outcome } : {}),
    ...(event.actorId ? { actorId: event.actorId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
  };
}

function defaultEmit(event: SafeAuthEvent): void {
  console.info(JSON.stringify({ component: "auth", ...event }));
}

const SERVICE_PRINCIPAL_API_KEY_PREFIX = "spk";

export function createSkillplaneAuthServer(
  input: CreateSkillplaneAuthServerInput,
): SkillplaneAuthServer {
  const emit = input.emit ?? defaultEmit;
  const apiKeyConfig = {
    database: input.database.adapter,
    namespace: "authfn",
  } as const;
  const oauth = createSkillplaneOAuth({
    ...input.oauth,
    pool: input.database.pool,
    emit: async (event) => {
      await input.oauth.emit?.(event);
      await emit({
        type: event.type,
        requestId: event.requestId,
        outcome: event.outcome,
        ...(event.actorId ? { actorId: event.actorId } : {}),
        ...(event.clientId ? { clientId: event.clientId } : {}),
      });
    },
  });
  const plugins: AuthFnConfig["plugins"] = [
    authFnEmailOtpPlugin({
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.codeGenerator ? { codeGenerator: input.codeGenerator } : {}),
      ...(input.now ? { now: input.now } : {}),
      challengeTtlSeconds: 10 * 60,
      maxAttempts: 5,
    }),
    authFnApiKeyPlugin({
      secretPrefix: SERVICE_PRINCIPAL_API_KEY_PREFIX,
      ...(input.now ? { now: input.now } : {}),
    }),
    oauth.plugin,
  ];
  const authfn = createAuthFn({
    database: input.database.adapter,
    namespace: "authfn",
    basePath: "/auth",
    plugins,
    cookie: AUTH_COOKIE_CONFIG,
    accountLinking: {
      otpSignUpExistingUser: true,
    },
    observability: {
      emit: (event) => emit(safeEvent(event)),
    },
    openApi: {
      title: "Skillplane Auth API",
      version: "1.0.0",
    },
  });
  const app = createAuthApplication({
    authfn,
    ...(input.rateLimiter ? { rateLimiter: input.rateLimiter } : {}),
    ...(input.turnstile ? { turnstile: input.turnstile } : {}),
  });
  return {
    authfn,
    provider: authfn.provider,
    oauth: oauth.runtime,
    apiKeys: {
      async create(options) {
        const created = await createApiKey(
          apiKeyConfig,
          {
            // AuthFn's persisted schema permits unowned keys, but its current
            // create input type is narrower than that database contract.
            userId: null as unknown as string,
            name: options.name,
            scopes: [...options.scopes],
            metadata: { ...options.metadata },
            ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
          },
          {
            ...(input.now ? { now: input.now } : {}),
            secretPrefix: SERVICE_PRINCIPAL_API_KEY_PREFIX,
          },
        );
        try {
          await emit({
            type: "authfn.api_key.created",
            requestId: options.requestId,
            outcome: "created",
            actorId: options.ownerUserId,
          });
        } catch {
          console.error(
            JSON.stringify({
              component: "auth",
              event: "authfn.api_key.created.emit_failed",
              requestId: options.requestId,
              actorId: options.ownerUserId,
              keyId: created.keyId,
            }),
          );
        }
        return { keyId: created.keyId, secret: created.secret };
      },
      authenticate: (secret) =>
        authenticateApiKey(apiKeyConfig, secret, {
          ...(input.now ? { now: input.now } : {}),
        }),
      async revoke(options) {
        await revokeApiKeyById(apiKeyConfig, options.keyId, {
          ...(input.now ? { now: input.now } : {}),
        });
        await emit({
          type: "authfn.api_key.revoked",
          requestId: options.requestId,
          outcome: "revoked",
          actorId: options.actorId,
        });
      },
    },
    handle: async (request) => app.fetch(request),
    getSchema: () => authfn.getSchema(),
  };
}
