import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  migrateDatabase,
  resolveTestDatabaseUrl,
  type DatabaseClient,
} from "@skillplane/db";
import {
  createSkillplaneSendFn,
  type CloudflareEmailMessage,
  type SkillplaneSendFn,
} from "@skillplane/email";
import type { Pool } from "pg";
import {
  createPostgresOtpRateLimiter,
  createSkillplaneAuthServer,
  type SafeAuthEvent,
  type SkillplaneAuthServer,
} from "../../src/index.js";

export interface AuthTestEnvironment {
  readonly database: DatabaseClient;
  readonly email: string;
  readonly events: SafeAuthEvent[];
  readonly messages: CloudflareEmailMessage[];
  readonly pool: Pool;
  readonly sendfn: SkillplaneSendFn;
  readonly server: SkillplaneAuthServer;
  close(): Promise<void>;
  request(
    path: string,
    options?: {
      readonly body?: Record<string, unknown>;
      readonly headers?: HeadersInit;
      readonly method?: string;
    },
  ): Promise<Response>;
}

export interface AuthTestEnvironmentOptions {
  readonly now?: () => Date;
  readonly recipientLimit?: number;
  readonly networkLimit?: number;
  readonly emit?: (event: SafeAuthEvent) => Promise<void> | void;
}

export function cookieHeader(response: Response): string {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies = headers.getSetCookie?.() ?? [
    response.headers.get("set-cookie") ?? "",
  ];
  return setCookies
    .filter(Boolean)
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

export function csrfFromCookieHeader(value: string): string {
  const match = /(?:^|;\s*)skillplane\.csrf=([^;]+)/.exec(value);
  if (!match?.[1]) throw new Error("CSRF cookie was not issued");
  return decodeURIComponent(match[1]);
}

export async function createAuthTestEnvironment(
  options: AuthTestEnvironmentOptions = {},
): Promise<AuthTestEnvironment> {
  const databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  const database = createDatabaseClient({
    connectionString: databaseUrl,
    applicationName: "skillplane-auth-test",
    maxConnections: 4,
  });
  const suffix = randomUUID().replaceAll("-", "");
  const email = `auth-${suffix}@auth.skillplane.test`;
  const messages: CloudflareEmailMessage[] = [];
  const events: SafeAuthEvent[] = [];
  const sendfn = createSkillplaneSendFn({
    from: "Skillplane <no-reply@auth.skillplane.dev>",
    environment: "production",
    signInUrl: "https://app.skillplane.dev",
    binding: {
      async send(message) {
        messages.push(message);
        return { messageId: `cf_test_${messages.length}` };
      },
    },
  });
  const server = createSkillplaneAuthServer({
    database,
    oauth: {
      issuer: "https://app.skillplane.dev",
      resource: "https://mcp.skillplane.dev/mcp",
      tokenPepper: "auth-test-oauth-token-pepper-32-characters",
    },
    delivery: sendfn.delivery,
    codeGenerator: () => "123456",
    ...(options.now ? { now: options.now } : {}),
    rateLimiter: createPostgresOtpRateLimiter({
      pool: database.pool,
      pepper: `auth-test-rate-limit-pepper-32-characters-${suffix}`,
      ...(options.recipientLimit ? { recipientLimit: options.recipientLimit } : {}),
      ...(options.networkLimit ? { networkLimit: options.networkLimit } : {}),
      windowSeconds: 15 * 60,
    }),
    turnstile: {
      verify: ({ token }) =>
        Promise.resolve(
          token === "turnstile-pass"
            ? { success: true, reason: "verified" }
            : { success: false, reason: "invalid" },
        ),
    },
    emit:
      options.emit ??
      ((event) => {
        events.push(event);
      }),
  });

  return {
    database,
    email,
    events,
    messages,
    pool: database.pool,
    sendfn,
    server,
    request(path, requestOptions = {}) {
      return server.handle(
        new Request(`https://app.skillplane.dev${path}`, {
          method: requestOptions.method ?? "POST",
          headers: {
            "cf-connecting-ip": "203.0.113.42",
            "content-type": "application/json",
            "x-request-id": "req_auth_test",
            ...requestOptions.headers,
          },
          ...(requestOptions.body ? { body: JSON.stringify(requestOptions.body) } : {}),
        }),
      );
    },
    async close() {
      await database.pool.query("DELETE FROM authfn_otp_challenges WHERE email = $1", [
        email,
      ]);
      await database.pool.query("DELETE FROM authfn_users WHERE primary_email = $1", [
        email,
      ]);
      await sendfn.close();
      await database.close();
    },
  };
}
