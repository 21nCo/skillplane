import { z } from "zod";
import {
  createSingleCellTopology,
  parseTopologyManifest,
  type SkillplaneTopologyManifest,
} from "@skillplane/control-plane";

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
  readonly [binding: string]: unknown;
  readonly RUNTIME_ENV?: string;
  readonly DATABASE_ADAPTER?: string;
  readonly DATABASE_URL?: string;
  readonly AUTH_MODE?: string;
  readonly EMAIL_PROVIDER?: string;
  readonly AUTHFN_SECRET?: string;
  readonly OAUTH_TOKEN_PEPPER?: string;
  readonly OAUTH_ISSUER?: string;
  readonly OAUTH_RESOURCE?: string;
  readonly SKILLPLANE_ROLE?: string;
  readonly SKILLPLANE_REGION_ID?: string;
  readonly SKILLPLANE_TOPOLOGY?: string;
  readonly WORKSPACE_ROUTING_KEYS?: string;
  readonly POSTHOG_HOST?: string;
  readonly POSTHOG_PROJECT_TOKEN?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly TURNSTILE_ALLOWED_HOSTNAMES?: string;
  readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
  readonly SKILLPLANE_OTP_FROM?: string;
  readonly HYPERDRIVE?: HyperdriveBinding;
  readonly CONTROL_HYPERDRIVE?: HyperdriveBinding;
  readonly CELL_HYPERDRIVE?: HyperdriveBinding;
  readonly SKILL_BUNDLES?: ObjectStorageBinding;
  readonly PUBLIC_SKILL_BUNDLES?: ObjectStorageBinding;
  readonly CELL_SKILL_BUNDLES?: ObjectStorageBinding;
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

export interface RuntimeDatabaseConfig {
  readonly adapter: "postgres";
  readonly connectionString: string;
  readonly source: "direct-postgres" | "hyperdrive";
}

export interface RuntimeConfig {
  readonly environment: RuntimeEnvironment;
  readonly database: RuntimeDatabaseConfig;
  readonly objectStorage: ObjectStorageBinding;
  readonly deployment: {
    readonly role: "single" | "gateway" | "control" | "cell";
    readonly regionId: string | null;
    readonly topology: SkillplaneTopologyManifest;
  };
  readonly controlDatabase: RuntimeDatabaseConfig;
  readonly regionalDatabase: RuntimeDatabaseConfig | null;
  readonly publicObjectStorage: ObjectStorageBinding | null;
  readonly regionalObjectStorage: ObjectStorageBinding | null;
  readonly routing: {
    readonly activeKeyId: string;
    readonly keys: Readonly<Record<string, string>>;
    readonly audience: string;
    readonly ttlMs: number;
  };
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
    readonly resource: string;
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
const authModeSchema = z.enum(["disabled", "otp"]);

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

function validateCloudflareEmailProvider(
  bindings: RuntimeBindings,
  environment: RuntimeEnvironment,
): void {
  if (bindings.EMAIL_PROVIDER !== "cloudflare-email") {
    throw new ConfigError(
      environment === "local" ? "CONFIG_INVALID" : "PRODUCTION_ADAPTER_INVALID",
      "OTP authentication requires the Cloudflare Email Service provider",
      ["EMAIL_PROVIDER"],
    );
  }
}

function parseEmailSender(
  value: string | undefined,
  environment: RuntimeEnvironment,
  missing: string[],
): string | null {
  const expectedAddress =
    environment === "production"
      ? "no-reply@auth.skillplane.dev"
      : "no-reply@auth-dev.skillplane.dev";
  const normalized = value?.trim();
  const address = normalized
    ? (/^[^<>\r\n]+\s*<([^\s<>@]+@[^\s<>@]+)>$/.exec(normalized)?.[1] ??
      /^([^\s<>@]+@[^\s<>@]+)$/.exec(normalized)?.[1])
    : undefined;
  if (!normalized || address?.toLowerCase() !== expectedAddress) {
    missing.push("SKILLPLANE_OTP_FROM");
    return null;
  }
  return normalized;
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

function readAuthMode(
  bindings: RuntimeBindings,
  environment: RuntimeEnvironment,
): "disabled" | "otp" {
  const result = authModeSchema.safeParse(bindings.AUTH_MODE);
  if (!result.success) {
    throw new ConfigError(
      environment === "local" ? "CONFIG_INVALID" : "PRODUCTION_ADAPTER_INVALID",
      "Authentication mode must be explicit",
      ["AUTH_MODE"],
    );
  }
  if (environment !== "local" && result.data !== "otp") {
    throw new ConfigError(
      "PRODUCTION_ADAPTER_INVALID",
      "Preview and production require OTP authentication",
      ["AUTH_MODE"],
    );
  }
  return result.data;
}

function parseAuthConfiguration(
  bindings: RuntimeBindings,
  environment: RuntimeEnvironment,
): Pick<RuntimeConfig, "auth" | "email"> {
  const authMode = readAuthMode(bindings, environment);
  if (authMode === "disabled") {
    return { auth: null, email: null };
  }
  validateCloudflareEmailProvider(bindings, environment);
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
  const from = parseEmailSender(bindings.SKILLPLANE_OTP_FROM, environment, missing);
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

export interface OAuthEndpoints {
  readonly issuer: string;
  readonly resource: string;
}

function parseOAuthUrl(
  value: string,
  field: "OAUTH_ISSUER" | "OAUTH_RESOURCE",
  environment: RuntimeEnvironment,
  productionValue: string,
  missing: string[],
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    missing.push(field);
    return null;
  }
  const loopbackHttp =
    environment === "local" &&
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  const normalized = parsed.toString().replace(/\/$/u, "");
  const canonicalPath =
    field === "OAUTH_ISSUER" ? parsed.pathname === "/" : parsed.pathname === "/mcp";
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !canonicalPath ||
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    (environment === "production" && normalized !== productionValue)
  ) {
    missing.push(field);
    return null;
  }
  return normalized;
}

export function parseOAuthEndpoints(
  bindings: Pick<RuntimeBindings, "RUNTIME_ENV" | "OAUTH_ISSUER" | "OAUTH_RESOURCE">,
): OAuthEndpoints {
  const environment = readEnvironment(bindings);
  const missing: string[] = [];
  const issuer = parseOAuthUrl(
    bindings.OAUTH_ISSUER ??
      (environment === "local"
        ? "http://localhost:5700"
        : environment === "preview"
          ? "https://app-dev.skillplane.dev"
          : "https://app.skillplane.dev"),
    "OAUTH_ISSUER",
    environment,
    "https://app.skillplane.dev",
    missing,
  );
  const resource = parseOAuthUrl(
    bindings.OAUTH_RESOURCE ??
      (environment === "local"
        ? "http://127.0.0.1:5701/mcp"
        : environment === "preview"
          ? "https://mcp-dev.skillplane.dev/mcp"
          : "https://mcp.skillplane.dev/mcp"),
    "OAUTH_RESOURCE",
    environment,
    "https://mcp.skillplane.dev/mcp",
    missing,
  );
  if (missing.length > 0 || !issuer || !resource) {
    throw new ConfigError(
      environment === "local" ? "CONFIG_INVALID" : "PRODUCTION_BINDING_MISSING",
      "OAuth endpoint configuration is unavailable",
      [...new Set(missing)].sort((left, right) => left.localeCompare(right)),
    );
  }
  return { issuer, resource };
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
  const endpoints = parseOAuthEndpoints(bindings);
  if (missing.length > 0 || !tokenPepper) {
    throw new ConfigError(
      environment === "local" ? "CONFIG_INVALID" : "PRODUCTION_BINDING_MISSING",
      "OAuth authorization server configuration is unavailable",
      [...new Set(missing)].sort(),
    );
  }
  return {
    ...endpoints,
    tokenPepper,
  };
}

type RuntimeBaseConfig = Omit<
  RuntimeConfig,
  | "deployment"
  | "controlDatabase"
  | "regionalDatabase"
  | "publicObjectStorage"
  | "regionalObjectStorage"
  | "routing"
>;

function databaseFromBinding(
  value: unknown,
  environment: RuntimeEnvironment,
): RuntimeDatabaseConfig | null {
  if (isHyperdriveBinding(value)) {
    return {
      adapter: "postgres",
      connectionString: value.connectionString,
      source: "hyperdrive",
    };
  }
  if (environment === "local" && typeof value === "string" && isPostgresUrl(value)) {
    return {
      adapter: "postgres",
      connectionString: value,
      source: "direct-postgres",
    };
  }
  return null;
}

function routingKeys(
  bindings: RuntimeBindings,
  base: RuntimeBaseConfig,
  topology: SkillplaneTopologyManifest,
): RuntimeConfig["routing"] {
  let keys: Record<string, string> = {};
  if (typeof bindings.WORKSPACE_ROUTING_KEYS === "string") {
    try {
      const parsed: unknown = JSON.parse(bindings.WORKSPACE_ROUTING_KEYS);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every(
          (value) => typeof value === "string" && value.length >= 32,
        )
      ) {
        keys = parsed as Record<string, string>;
      }
    } catch {
      // The stable diagnostic below deliberately omits secret parsing details.
    }
  }
  if (
    topology.mode === "single-cell" &&
    typeof bindings.SKILLPLANE_TOPOLOGY !== "string" &&
    Object.keys(keys).length === 0
  ) {
    keys = {
      [topology.routing.activeKeyId]: base.secrets.authfn ?? base.secrets.oauth,
    };
  }
  const expected = new Set(topology.routing.verificationKeyIds);
  const received = new Set(Object.keys(keys));
  if (
    expected.size !== received.size ||
    [...expected].some((keyId) => !received.has(keyId)) ||
    !keys[topology.routing.activeKeyId]
  ) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "The workspace routing keyring is unavailable",
      ["WORKSPACE_ROUTING_KEYS"],
    );
  }
  if (
    topology.mode === "multi-cell" &&
    Object.values(keys).some(
      (secret) => secret === base.secrets.authfn || secret === base.secrets.oauth,
    )
  ) {
    throw new ConfigError(
      "CONFIG_INVALID",
      "Workspace routing keys must be independent from authentication secrets",
      ["WORKSPACE_ROUTING_KEYS"],
    );
  }
  return {
    activeKeyId: topology.routing.activeKeyId,
    keys,
    audience: topology.routing.assertionAudience,
    ttlMs: topology.routing.assertionTtlSeconds * 1_000,
  };
}

function attachTopology(
  base: RuntimeBaseConfig,
  bindings: RuntimeBindings,
): RuntimeConfig {
  const explicit = typeof bindings.SKILLPLANE_TOPOLOGY === "string";
  const topology = explicit
    ? parseTopologyManifest(bindings.SKILLPLANE_TOPOLOGY, {
        production: base.environment === "production",
      })
    : createSingleCellTopology({
        appAuthority: base.oauth.issuer,
        mcpResource: base.oauth.resource,
        controlDatabaseBinding: "HYPERDRIVE",
        publicObjectStorageBinding: "SKILL_BUNDLES",
        regionId: "legacy",
        regionalDatabaseBinding: "CELL_HYPERDRIVE",
        regionalObjectStorageBinding: "CELL_SKILL_BUNDLES",
      });
  const role = explicit ? bindings.SKILLPLANE_ROLE : "single";
  if (!role || !["single", "gateway", "control", "cell"].includes(role)) {
    throw new ConfigError("CONFIG_INVALID", "Deployment role is invalid", [
      "SKILLPLANE_ROLE",
    ]);
  }
  if (explicit && role === "single") {
    throw new ConfigError(
      "CONFIG_INVALID",
      "An explicit topology requires a gateway, control, or cell role",
      ["SKILLPLANE_ROLE"],
    );
  }
  const selectedRegion =
    role === "cell"
      ? topology.cells.find((cell) => cell.regionId === bindings.SKILLPLANE_REGION_ID)
      : undefined;
  if (role === "cell" && !selectedRegion) {
    throw new ConfigError(
      "CONFIG_INVALID",
      "The regional cell is not declared by the topology",
      ["SKILLPLANE_REGION_ID"],
    );
  }
  const controlDatabase = explicit
    ? databaseFromBinding(
        bindings[topology.controlPlane.databaseBinding],
        base.environment,
      )
    : base.database;
  const regionalDatabase = selectedRegion
    ? databaseFromBinding(bindings[selectedRegion.databaseBinding], base.environment)
    : role === "single"
      ? base.database
      : null;
  const publicObjectStorage = explicit
    ? bindings[topology.controlPlane.publicObjectStorageBinding]
    : base.objectStorage;
  const regionalObjectStorage = selectedRegion
    ? bindings[selectedRegion.objectStorageBinding]
    : role === "single"
      ? base.objectStorage
      : null;
  const missing: string[] = [];
  if (!controlDatabase) missing.push(topology.controlPlane.databaseBinding);
  if (role === "cell" && !regionalDatabase) {
    missing.push(selectedRegion?.databaseBinding ?? "SKILLPLANE_REGION_ID");
  }
  if (
    ["single", "gateway", "control"].includes(role) &&
    !isObjectStorageBinding(publicObjectStorage)
  ) {
    missing.push(topology.controlPlane.publicObjectStorageBinding);
  }
  if (role === "cell" && !isObjectStorageBinding(regionalObjectStorage)) {
    missing.push(selectedRegion?.objectStorageBinding ?? "SKILLPLANE_REGION_ID");
  }
  if (missing.length > 0 || !controlDatabase) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "Topology database or object-storage bindings are unavailable",
      [...new Set(missing)].sort(),
    );
  }
  const publicStorage = isObjectStorageBinding(publicObjectStorage)
    ? publicObjectStorage
    : null;
  const regionalStorage = isObjectStorageBinding(regionalObjectStorage)
    ? regionalObjectStorage
    : null;
  return {
    ...base,
    database: regionalDatabase ?? controlDatabase,
    objectStorage: regionalStorage ?? publicStorage ?? base.objectStorage,
    deployment: {
      role: role as RuntimeConfig["deployment"]["role"],
      regionId: selectedRegion?.regionId ?? (role === "single" ? "legacy" : null),
      topology,
    },
    controlDatabase,
    regionalDatabase,
    publicObjectStorage: publicStorage,
    regionalObjectStorage: regionalStorage,
    routing: routingKeys(bindings, base, topology),
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
  const explicitTopology =
    typeof bindings.SKILLPLANE_TOPOLOGY === "string"
      ? parseTopologyManifest(bindings.SKILLPLANE_TOPOLOGY, {
          production: environment === "production",
        })
      : null;
  const configuredRole = explicitTopology ? bindings.SKILLPLANE_ROLE : "single";
  const configuredCell =
    explicitTopology && configuredRole === "cell"
      ? explicitTopology.cells.find(
          (cell) => cell.regionId === bindings.SKILLPLANE_REGION_ID,
        )
      : null;
  const baseStorageBinding = explicitTopology
    ? configuredRole === "cell"
      ? configuredCell?.objectStorageBinding
      : explicitTopology.controlPlane.publicObjectStorageBinding
    : "SKILL_BUNDLES";
  const baseObjectStorage = baseStorageBinding
    ? bindings[baseStorageBinding]
    : undefined;

  if (!isObjectStorageBinding(baseObjectStorage)) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "Object storage binding is unavailable",
      [baseStorageBinding ?? "SKILLPLANE_REGION_ID"],
    );
  }

  if (environment === "local") {
    const explicitDatabase = explicitTopology
      ? databaseFromBinding(
          bindings[explicitTopology.controlPlane.databaseBinding],
          environment,
        )
      : null;
    const legacyDatabase = databaseFromBinding(bindings.DATABASE_URL, environment);
    const baseDatabase = explicitDatabase ?? legacyDatabase;
    if (!baseDatabase) {
      throw new ConfigError(
        "CONFIG_INVALID",
        "Local Postgres configuration is invalid",
        [
          explicitTopology
            ? explicitTopology.controlPlane.databaseBinding
            : "DATABASE_URL",
        ],
      );
    }

    const authentication = oauthOnly
      ? { auth: null, email: null }
      : parseAuthConfiguration(bindings, environment);
    return attachTopology(
      {
        environment,
        database: baseDatabase,
        objectStorage: baseObjectStorage,
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
      },
      bindings,
    );
  }

  const productionDatabaseBinding = explicitTopology
    ? explicitTopology.controlPlane.databaseBinding
    : "HYPERDRIVE";
  const productionDatabase = databaseFromBinding(
    bindings[productionDatabaseBinding],
    environment,
  );
  const missing: string[] = [];
  if (!productionDatabase) missing.push(productionDatabaseBinding);
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

  if (!productionDatabase) {
    throw new ConfigError(
      "PRODUCTION_BINDING_MISSING",
      "Hyperdrive binding is unavailable",
      [productionDatabaseBinding],
    );
  }
  const authentication = oauthOnly
    ? { auth: null, email: null }
    : parseAuthConfiguration(bindings, environment);

  return attachTopology(
    {
      environment,
      database: productionDatabase,
      objectStorage: baseObjectStorage,
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
    },
    bindings,
  );
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
