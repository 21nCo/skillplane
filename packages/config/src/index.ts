import { z } from "zod";

export type RuntimeEnvironment = "local" | "preview" | "production";

export interface HyperdriveBinding {
  readonly connectionString: string;
}

export interface ObjectStorageBinding {
  head(key: string): Promise<unknown>;
  get(key: string): Promise<unknown>;
  put(
    key: string,
    value: Uint8Array,
    options?: {
      readonly onlyIf?: { readonly etagDoesNotMatch?: string };
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Readonly<Record<string, string>>;
    },
  ): Promise<unknown>;
  delete(keys: string | readonly string[]): Promise<void>;
  list(options?: {
    readonly prefix?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<unknown>;
}

export interface EmailServiceBinding {
  send(message: unknown): Promise<{ readonly messageId: string }>;
}

export interface RuntimeBindings {
  readonly RUNTIME_ENV?: string;
  readonly DATABASE_ADAPTER?: string;
  readonly DATABASE_URL?: string;
  readonly EMAIL_PROVIDER?: string;
  readonly AUTHFN_SECRET?: string;
  readonly OAUTH_TOKEN_PEPPER?: string;
  readonly OAUTH_ISSUER?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly TURNSTILE_ALLOWED_HOSTNAMES?: string;
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
  readonly SKILLPLANE_OTP_FROM?: string;
  readonly HYPERDRIVE?: HyperdriveBinding;
  readonly SKILL_BUNDLES?: ObjectStorageBinding;
  readonly SEND_EMAIL?: EmailServiceBinding;
}

export type ConfigErrorCode =
  | "CONFIG_INVALID"
  | "DATABASE_ADAPTER_INVALID"
  | "PRODUCTION_ADAPTER_INVALID"
  | "PRODUCTION_BINDING_MISSING";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly fields: readonly string[];

  constructor(code: ConfigErrorCode, message: string, fields: readonly string[]) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.fields = fields;
  }
}

export interface RuntimeDiagnostics {
  readonly environment: RuntimeEnvironment;
  readonly database: "direct-postgres" | "hyperdrive";
  readonly objectStorage: "r2";
  readonly email: "cloudflare-email" | "not-required-local" | "not-required-oauth-only";
  readonly secretPresence: {
    readonly authfn: boolean;
    readonly turnstile: boolean;
    readonly oauth: boolean;
  };
}

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment;
  readonly database: {
    readonly adapter: "postgres";
    readonly connectionString: string;
    readonly source: "direct-postgres" | "hyperdrive";
  };
  readonly objectStorage: ObjectStorageBinding;
  readonly email: {
    readonly provider: "cloudflare-email";
    readonly binding: EmailServiceBinding;
    readonly from: string;
  } | null;
  readonly auth: {
    readonly rateLimitPepper: string;
    readonly turnstile: {
      readonly secretKey: string;
      readonly siteKey: string;
      readonly action: "otp_send";
      readonly allowedHostnames: readonly string[];
    };
  } | null;
  readonly oauth: {
    readonly issuer: string;
    readonly resource: "https://mcp.skillplane.dev/mcp";
    readonly tokenPepper: string;
  };
  readonly secrets: {
    readonly authfn: string | null;
    readonly turnstile: string | null;
    readonly oauth: string;
  };
  readonly diagnostics: RuntimeDiagnostics;
}

export interface RuntimeConfigOptions {
  readonly authentication?: "full" | "oauth-only";
}

const environmentSchema = z.enum(["local", "preview", "production"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasFunction<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, (...args: never[]) => unknown> {
  return isRecord(value) && typeof value[key] === "function";
}

function isObjectStorageBinding(value: unknown): value is ObjectStorageBinding {
  return (
    hasFunction(value, "head") &&
    hasFunction(value, "get") &&
    hasFunction(value, "put") &&
    hasFunction(value, "delete") &&
    hasFunction(value, "list")
  );
}

function isEmailServiceBinding(value: unknown): value is EmailServiceBinding {
  return hasFunction(value, "send");
}

function isHyperdriveBinding(value: unknown): value is HyperdriveBinding {
  return (
    isRecord(value) &&
    typeof value.connectionString === "string" &&
    isPostgresUrl(value.connectionString)
  );
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      url.hostname.length > 0 &&
      url.username.length > 0 &&
      url.password.length > 0 &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

function readEnvironment(bindings: RuntimeBindings): RuntimeEnvironment {
  const result = environmentSchema.safeParse(bindings.RUNTIME_ENV);
  if (!result.success) {
    throw new ConfigError("CONFIG_INVALID", "Runtime environment is invalid", [
      "RUNTIME_ENV",
    ]);
  }
  return result.data;
}

function validateDatabaseAdapter(bindings: RuntimeBindings): void {
  if ((bindings.DATABASE_ADAPTER ?? "postgres") !== "postgres") {
    throw new ConfigError(
      "DATABASE_ADAPTER_INVALID",
      "Only the Postgres database adapter is permitted",
      ["DATABASE_ADAPTER"],
    );
  }
}

function validateProductionEmailProvider(bindings: RuntimeBindings): void {
  if (bindings.EMAIL_PROVIDER !== "cloudflare-email") {
    throw new ConfigError(
      "PRODUCTION_ADAPTER_INVALID",
      "Production requires the Cloudflare Email Service provider",
      ["EMAIL_PROVIDER"],
    );
  }
}

function parseEmailSender(value: string | undefined, missing: string[]): string | null {
  if (
    typeof value !== "string" ||
    !/^(?:[^<>\r\n]+\s*<)?[^\s<>@]+@auth\.skillplane\.dev>?$/.test(value.trim())
  ) {
    missing.push("SKILLPLANE_OTP_FROM");
    return null;
  }
  return value.trim();
}

function parseSiteKey(value: string | undefined, missing: string[]): string | null {
  if (typeof value !== "string" || value.trim().length < 10) {
    missing.push("PUBLIC_TURNSTILE_SITE_KEY");
    return null;
  }
  return value.trim();
}

function parseAllowedHostnames(
  value: string | undefined,
  environment: RuntimeEnvironment,
  missing: string[],
): readonly string[] {
  const hostnames =
    value
      ?.split(",")
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean) ?? [];
  if (
    hostnames.length === 0 ||
    hostnames.some(
      (hostname) =>
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          hostname,
        ),
    ) ||
    (environment !== "local" &&
      hostnames.some((hostname) => ["localhost", "127.0.0.1"].includes(hostname)))
  ) {
    missing.push("TURNSTILE_ALLOWED_HOSTNAMES");
    return [];
  }
  return [...new Set(hostnames)].sort();
}

function hasLocalAuthConfiguration(bindings: RuntimeBindings): boolean {
  return [
    bindings.EMAIL_PROVIDER,
    bindings.AUTHFN_SECRET,
    bindings.TURNSTILE_SECRET_KEY,
    bindings.TURNSTILE_ALLOWED_HOSTNAMES,
    bindings.PUBLIC_TURNSTILE_SITE_KEY,
    bindings.SKILLPLANE_OTP_FROM,
    bindings.SEND_EMAIL,
  ].some((value) => value !== undefined);
}

function parseAuthConfiguration(
  bindings: RuntimeBindings,
  environment: RuntimeEnvironment,
): Pick<RuntimeConfig, "auth" | "email"> {
  if (environment === "local" && !hasLocalAuthConfiguration(bindings)) {
    return { auth: null, email: null };
  }
  validateProductionEmailProvider(bindings);
  const missing: string[] = [];
  if (!isEmailServiceBinding(bindings.SEND_EMAIL)) {
    missing.push("SEND_EMAIL");
  }
  const authfnSecret = requireSecret(bindings.AUTHFN_SECRET, "AUTHFN_SECRET", missing);
  const turnstileSecret = requireSecret(
    bindings.TURNSTILE_SECRET_KEY,
    "TURNSTILE_SECRET_KEY",
    missing,
  );
  const from = parseEmailSender(bindings.SKILLPLANE_OTP_FROM, missing);
  const siteKey = parseSiteKey(bindings.PUBLIC_TURNSTILE_SITE_KEY, missing);
  const allowedHostnames = parseAllowedHostnames(
    bindings.TURNSTILE_ALLOWED_HOSTNAMES,
    environment,
    missing,
  );
  if (missing.length > 0) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "Required authentication bindings are unavailable",
      [...new Set(missing)].sort(),
    );
  }
  if (
    !isEmailServiceBinding(bindings.SEND_EMAIL) ||
    !authfnSecret ||
    !turnstileSecret ||
    !from ||
    !siteKey
  ) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "Required authentication bindings are unavailable",
      ["AUTH_CONFIGURATION"],
    );
  }
  return {
    email: {
      provider: "cloudflare-email",
      binding: bindings.SEND_EMAIL,
      from,
    },
    auth: {
      rateLimitPepper: authfnSecret,
      turnstile: {
        secretKey: turnstileSecret,
        siteKey,
        action: "otp_send",
        allowedHostnames,
      },
    },
  };
}

function requireSecret(
  value: string | undefined,
  field: string,
  missing: string[],
): string | null {
  if (typeof value !== "string" || value.length < 32) {
    missing.push(field);
    return null;
  }
  return value;
}

function parseOAuthConfiguration(
  bindings: RuntimeBindings,
  environment: RuntimeEnvironment,
): RuntimeConfig["oauth"] {
  const missing: string[] = [];
  const tokenPepper =
    environment === "local" && bindings.OAUTH_TOKEN_PEPPER === undefined
      ? "skillplane-local-oauth-pepper-not-for-production"
      : requireSecret(bindings.OAUTH_TOKEN_PEPPER, "OAUTH_TOKEN_PEPPER", missing);
  const issuer =
    bindings.OAUTH_ISSUER ??
    (environment === "local" ? "http://localhost:5173" : "https://app.skillplane.dev");
  let parsed: URL | null = null;
  try {
    parsed = new URL(issuer);
  } catch {
    missing.push("OAUTH_ISSUER");
  }
  const localLoopback =
    parsed?.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    !parsed ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (environment === "local"
      ? parsed.protocol !== "https:" && !localLoopback
      : parsed.toString().replace(/\/$/, "") !== "https://app.skillplane.dev")
  ) {
    missing.push("OAUTH_ISSUER");
  }
  if (missing.length > 0 || !tokenPepper) {
    throw new ConfigError(
      environment === "local" ? "CONFIG_INVALID" : "PRODUCTION_BINDING_MISSING",
      "OAuth authorization server configuration is unavailable",
      [...new Set(missing)].sort(),
    );
  }
  return {
    issuer: issuer.replace(/\/$/, ""),
    resource: "https://mcp.skillplane.dev/mcp",
    tokenPepper,
  };
}

export function parseRuntimeConfig(
  bindings: RuntimeBindings,
  options: RuntimeConfigOptions = {},
): RuntimeConfig {
  const environment = readEnvironment(bindings);
  const oauthOnly = options.authentication === "oauth-only";
  validateDatabaseAdapter(bindings);
  const oauth = parseOAuthConfiguration(bindings, environment);

  if (!isObjectStorageBinding(bindings.SKILL_BUNDLES)) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "Object storage binding is unavailable",
      ["SKILL_BUNDLES"],
    );
  }

  if (environment === "local") {
    if (
      typeof bindings.DATABASE_URL !== "string" ||
      !isPostgresUrl(bindings.DATABASE_URL)
    ) {
      throw new ConfigError(
        "CONFIG_INVALID",
        "Local Postgres configuration is invalid",
        ["DATABASE_URL"],
      );
    }

    const authentication = oauthOnly
      ? { auth: null, email: null }
      : parseAuthConfiguration(bindings, environment);
    return {
      environment,
      database: {
        adapter: "postgres",
        connectionString: bindings.DATABASE_URL,
        source: "direct-postgres",
      },
      objectStorage: bindings.SKILL_BUNDLES,
      email: authentication.email,
      auth: authentication.auth,
      oauth,
      secrets: {
        authfn: authentication.auth?.rateLimitPepper ?? null,
        turnstile: authentication.auth?.turnstile.secretKey ?? null,
        oauth: oauth.tokenPepper,
      },
      diagnostics: {
        environment,
        database: "direct-postgres",
        objectStorage: "r2",
        email: oauthOnly
          ? "not-required-oauth-only"
          : authentication.email
            ? "cloudflare-email"
            : "not-required-local",
        secretPresence: {
          authfn: Boolean(authentication.auth),
          turnstile: Boolean(authentication.auth),
          oauth: true,
        },
      },
    };
  }

  const missing: string[] = [];
  if (!isHyperdriveBinding(bindings.HYPERDRIVE)) {
    missing.push("HYPERDRIVE");
  }
  if (missing.length > 0) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "Required production bindings are unavailable",
      missing.sort(),
    );
  }

  if (bindings.DATABASE_URL !== undefined) {
    throw new ConfigError(
      "CONFIG_INVALID",
      "Production Workers must use Hyperdrive instead of DATABASE_URL",
      ["DATABASE_URL"],
    );
  }

  if (!isHyperdriveBinding(bindings.HYPERDRIVE)) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "Hyperdrive binding is unavailable",
      ["HYPERDRIVE"],
    );
  }
  const authentication = oauthOnly
    ? { auth: null, email: null }
    : parseAuthConfiguration(bindings, environment);

  return {
    environment,
    database: {
      adapter: "postgres",
      connectionString: bindings.HYPERDRIVE.connectionString,
      source: "hyperdrive",
    },
    objectStorage: bindings.SKILL_BUNDLES,
    email: authentication.email,
    auth: authentication.auth,
    oauth,
    secrets: {
      authfn: authentication.auth?.rateLimitPepper ?? null,
      turnstile: authentication.auth?.turnstile.secretKey ?? null,
      oauth: oauth.tokenPepper,
    },
    diagnostics: {
      environment,
      database: "hyperdrive",
      objectStorage: "r2",
      email: oauthOnly ? "not-required-oauth-only" : "cloudflare-email",
      secretPresence: {
        authfn: !oauthOnly,
        turnstile: !oauthOnly,
        oauth: true,
      },
    },
  };
}

export function safeConfigDiagnostic(error: unknown): {
  readonly code: ConfigErrorCode | "CONFIG_UNKNOWN";
  readonly fields: readonly string[];
} {
  if (error instanceof ConfigError) {
    return { code: error.code, fields: error.fields };
  }
  return { code: "CONFIG_UNKNOWN", fields: [] };
}
