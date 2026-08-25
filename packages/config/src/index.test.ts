import { describe, expect, it } from "vitest";
import {
  ConfigError,
  parseRuntimeConfig,
  safeConfigDiagnostic,
  type RuntimeBindings,
} from "./index.js";

const objectStorage = {
  async head() {
    return null;
  },
  async get() {
    return null;
  },
  async put() {
    return null;
  },
  delete() {
    return Promise.resolve();
  },
  async list() {
    return { objects: [] };
  },
};

const email = {
  async send() {
    return { messageId: "fixture-message" };
  },
};

const fixtureSecret = "fixture-only-secret-material-32-bytes";

function productionBindings(overrides: Partial<RuntimeBindings> = {}): RuntimeBindings {
  const environment = overrides.RUNTIME_ENV ?? "production";
  return {
    RUNTIME_ENV: "production",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "otp",
    EMAIL_PROVIDER: "cloudflare-email",
    HYPERDRIVE: {
      connectionString: "postgresql://fixture:fixture@database.invalid:5432/skillplane",
    },
    SKILL_BUNDLES: objectStorage,
    SEND_EMAIL: email,
    AUTHFN_SECRET: fixtureSecret,
    OAUTH_TOKEN_PEPPER: fixtureSecret,
    TURNSTILE_SECRET_KEY: fixtureSecret,
    TURNSTILE_ALLOWED_HOSTNAMES: "app.skillplane.dev,skillplane.dev",
    PUBLIC_TURNSTILE_SITE_KEY: "fixture-site-key",
    SKILLPLANE_OTP_FROM:
      environment === "production"
        ? "Skillplane <no-reply@auth.skillplane.dev>"
        : "Skillplane Dev <no-reply@auth-dev.skillplane.dev>",
    ...overrides,
  };
}

describe("parseRuntimeConfig", () => {
  it("accepts a complete local Postgres and R2 runtime", () => {
    const config = parseRuntimeConfig({
      RUNTIME_ENV: "local",
      DATABASE_ADAPTER: "postgres",
      DATABASE_URL: "postgresql://skillplane:fixture@127.0.0.1:5432/skillplane",
      AUTH_MODE: "disabled",
      SKILL_BUNDLES: objectStorage,
    });

    expect(config.environment).toBe("local");
    expect(config.oauth).toMatchObject({
      issuer: "http://localhost:5700",
      resource: "http://127.0.0.1:5701/mcp",
    });
    expect(config.database.source).toBe("direct-postgres");
    expect(config.diagnostics).toEqual({
      environment: "local",
      database: "direct-postgres",
      objectStorage: "r2",
      email: "not-required-local",
      secretPresence: { authfn: false, turnstile: false, oauth: true },
    });
  });

  it("accepts local OTP only with the isolated development sender", () => {
    const config = parseRuntimeConfig({
      RUNTIME_ENV: "local",
      DATABASE_ADAPTER: "postgres",
      DATABASE_URL: "postgresql://skillplane:fixture@127.0.0.1:5432/skillplane",
      AUTH_MODE: "otp",
      EMAIL_PROVIDER: "cloudflare-email",
      SKILL_BUNDLES: objectStorage,
      SEND_EMAIL: email,
      AUTHFN_SECRET: fixtureSecret,
      TURNSTILE_SECRET_KEY: fixtureSecret,
      TURNSTILE_ALLOWED_HOSTNAMES: "localhost,127.0.0.1",
      PUBLIC_TURNSTILE_SITE_KEY: "fixture-site-key",
      SKILLPLANE_OTP_FROM: "Skillplane Local <no-reply@auth-dev.skillplane.dev>",
    });

    expect(config.email?.from).toBe(
      "Skillplane Local <no-reply@auth-dev.skillplane.dev>",
    );
    expect(config.environment).toBe("local");
  });

  it("accepts distinct HTTPS OAuth endpoints for preview deployments", () => {
    const config = parseRuntimeConfig(
      productionBindings({
        RUNTIME_ENV: "preview",
        OAUTH_ISSUER: "https://app-dev.skillplane.dev",
        OAUTH_RESOURCE: "https://mcp-dev.skillplane.dev/mcp",
        TURNSTILE_ALLOWED_HOSTNAMES: "app-dev.skillplane.dev",
      }),
    );

    expect(config.environment).toBe("preview");
    expect(config.oauth).toMatchObject({
      issuer: "https://app-dev.skillplane.dev",
      resource: "https://mcp-dev.skillplane.dev/mcp",
    });
  });

  it("uses the canonical preview OAuth defaults without explicit overrides", () => {
    const config = parseRuntimeConfig(
      productionBindings({
        RUNTIME_ENV: "preview",
        OAUTH_ISSUER: undefined,
        OAUTH_RESOURCE: undefined,
        TURNSTILE_ALLOWED_HOSTNAMES: "app-dev.skillplane.dev",
      }),
    );

    expect(config.oauth).toMatchObject({
      issuer: "https://app-dev.skillplane.dev",
      resource: "https://mcp-dev.skillplane.dev/mcp",
    });
  });

  it("rejects production sender identity in preview", () => {
    expect(() =>
      parseRuntimeConfig(
        productionBindings({
          RUNTIME_ENV: "preview",
          SKILLPLANE_OTP_FROM: "Skillplane <no-reply@auth.skillplane.dev>",
          TURNSTILE_ALLOWED_HOSTNAMES: "app-dev.skillplane.dev",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "PRODUCTION_BINDING_MISSING",
        fields: ["SKILLPLANE_OTP_FROM"],
      }),
    );
  });

  it("rejects development sender identity in production", () => {
    expect(() =>
      parseRuntimeConfig(
        productionBindings({
          SKILLPLANE_OTP_FROM: "Skillplane Dev <no-reply@auth-dev.skillplane.dev>",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "PRODUCTION_BINDING_MISSING",
        fields: ["SKILLPLANE_OTP_FROM"],
      }),
    );
  });

  it("rejects non-canonical OAuth endpoint paths", () => {
    expect(() =>
      parseRuntimeConfig({
        RUNTIME_ENV: "local",
        DATABASE_ADAPTER: "postgres",
        DATABASE_URL: "postgresql://skillplane:fixture@127.0.0.1:5432/skillplane",
        AUTH_MODE: "disabled",
        SKILL_BUNDLES: objectStorage,
        OAUTH_ISSUER: "https://app.local.skillplane.dev/prefix",
        OAUTH_RESOURCE: "https://mcp.local.skillplane.dev/mcp/extra",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        fields: ["OAUTH_ISSUER", "OAUTH_RESOURCE"],
      }),
    );
  });

  it("rejects non-production OAuth identities in production", () => {
    expect(() =>
      parseRuntimeConfig(
        productionBindings({
          OAUTH_ISSUER: "https://app-dev.skillplane.dev",
          OAUTH_RESOURCE: "https://mcp-dev.skillplane.dev/mcp",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "PRODUCTION_BINDING_MISSING",
        fields: ["OAUTH_ISSUER", "OAUTH_RESOURCE"],
      }),
    );
  });

  it("accepts complete production bindings without exposing secrets", () => {
    const config = parseRuntimeConfig(productionBindings());

    expect(config.environment).toBe("production");
    expect(config.database.source).toBe("hyperdrive");
    expect(JSON.stringify(config.diagnostics)).not.toContain(fixtureSecret);
    expect(JSON.stringify(config.diagnostics)).not.toContain("database.invalid");
  });

  it("accepts an OAuth-only production runtime without email or Turnstile", () => {
    const config = parseRuntimeConfig(
      productionBindings({
        EMAIL_PROVIDER: undefined,
        SEND_EMAIL: undefined,
        AUTHFN_SECRET: undefined,
        TURNSTILE_SECRET_KEY: undefined,
        TURNSTILE_ALLOWED_HOSTNAMES: undefined,
        PUBLIC_TURNSTILE_SITE_KEY: undefined,
        SKILLPLANE_OTP_FROM: undefined,
      }),
      { authentication: "oauth-only" },
    );

    expect(config.email).toBeNull();
    expect(config.auth).toBeNull();
    expect(config.diagnostics).toMatchObject({
      email: "not-required-oauth-only",
      secretPresence: { authfn: false, turnstile: false, oauth: true },
    });
  });

  it("requires a distinct production OAuth token pepper", () => {
    expect(() =>
      parseRuntimeConfig(productionBindings({ OAUTH_TOKEN_PEPPER: undefined })),
    ).toThrowError(
      expect.objectContaining({
        code: "PRODUCTION_BINDING_MISSING",
        fields: ["OAUTH_TOKEN_PEPPER"],
      }),
    );
  });

  it("rejects a production capture email provider", () => {
    expect(() =>
      parseRuntimeConfig(
        productionBindings({
          EMAIL_PROVIDER: "capture",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "PRODUCTION_ADAPTER_INVALID",
        fields: ["EMAIL_PROVIDER"],
      }),
    );
  });

  it("rejects a partially configured local authentication runtime", () => {
    expect(() =>
      parseRuntimeConfig({
        RUNTIME_ENV: "local",
        DATABASE_ADAPTER: "postgres",
        DATABASE_URL: "postgresql://skillplane:fixture@127.0.0.1:5432/skillplane",
        SKILL_BUNDLES: objectStorage,
        AUTH_MODE: "otp",
        EMAIL_PROVIDER: "cloudflare-email",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PRODUCTION_BINDING_MISSING",
        fields: expect.arrayContaining([
          "AUTHFN_SECRET",
          "PUBLIC_TURNSTILE_SITE_KEY",
          "SEND_EMAIL",
          "SKILLPLANE_OTP_FROM",
          "TURNSTILE_ALLOWED_HOSTNAMES",
          "TURNSTILE_SECRET_KEY",
        ]),
      }),
    );
  });

  it("does not infer local authentication from an unused email binding", () => {
    const config = parseRuntimeConfig({
      RUNTIME_ENV: "local",
      DATABASE_ADAPTER: "postgres",
      DATABASE_URL: "postgresql://skillplane:fixture@127.0.0.1:5432/skillplane",
      SKILL_BUNDLES: objectStorage,
      AUTH_MODE: "disabled",
      SEND_EMAIL: email,
    });

    expect(config.auth).toBeNull();
    expect(config.email).toBeNull();
  });

  it("requires an explicit authentication mode for the application", () => {
    expect(() =>
      parseRuntimeConfig({
        RUNTIME_ENV: "local",
        DATABASE_ADAPTER: "postgres",
        DATABASE_URL: "postgresql://skillplane:fixture@127.0.0.1:5432/skillplane",
        SKILL_BUNDLES: objectStorage,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        fields: ["AUTH_MODE"],
      }),
    );
  });

  it("prevents production authentication from being disabled", () => {
    expect(() =>
      parseRuntimeConfig(productionBindings({ AUTH_MODE: "disabled" })),
    ).toThrowError(
      expect.objectContaining({
        code: "PRODUCTION_ADAPTER_INVALID",
        fields: ["AUTH_MODE"],
      }),
    );
  });

  it("rejects an in-memory database adapter in every runtime", () => {
    expect(() =>
      parseRuntimeConfig({
        RUNTIME_ENV: "local",
        DATABASE_ADAPTER: "memory",
        DATABASE_URL: "postgresql://skillplane:fixture@127.0.0.1:5432/skillplane",
        AUTH_MODE: "disabled",
        SKILL_BUNDLES: objectStorage,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "DATABASE_ADAPTER_INVALID",
        fields: ["DATABASE_ADAPTER"],
      }),
    );
  });

  it("rejects a production runtime without R2 before reading secrets", () => {
    expect(() =>
      parseRuntimeConfig(
        productionBindings({
          SKILL_BUNDLES: undefined,
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "PRODUCTION_BINDING_MISSING",
        fields: ["SKILL_BUNDLES"],
      }),
    );
  });

  it("rejects direct production database URLs", () => {
    expect(() =>
      parseRuntimeConfig(
        productionBindings({
          DATABASE_URL: "postgresql://fixture:fixture@railway.invalid:5432/skillplane",
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        fields: ["DATABASE_URL"],
      }),
    );
  });

  it("redacts unexpected errors into a stable diagnostic", () => {
    expect(safeConfigDiagnostic(new Error("contains-sensitive-detail"))).toEqual({
      code: "CONFIG_UNKNOWN",
      fields: [],
    });
    expect(
      safeConfigDiagnostic(
        new ConfigError("CONFIG_INVALID", "private detail", ["RUNTIME_ENV"]),
      ),
    ).toEqual({
      code: "CONFIG_INVALID",
      fields: ["RUNTIME_ENV"],
    });
  });
});
