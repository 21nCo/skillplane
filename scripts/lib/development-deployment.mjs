import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  capture,
  captureWrangler,
  parseDirectPostgresUrl,
  requireEnvironment,
  requireSecretEnvironment,
  root,
  run,
  writeJsonAtomic,
} from "./production-deployment.mjs";

export const developmentIssuer = "https://app-dev.skillplane.dev";
export const developmentResource = "https://mcp-dev.skillplane.dev/mcp";
export const developmentBucket = "skillplane-skill-bundles-dev";
export const developmentStateDirectory = resolve(root, ".data", "development");

export const developmentWorkers = Object.freeze({
  app: {
    name: "skillplane-app-dev",
    host: "app-dev.skillplane.dev",
    directory: resolve(root, "app"),
    config: resolve(root, "app", "wrangler.development.generated.json"),
    template: resolve(root, "deployment", "wrangler", "app.development.json"),
    secrets: ["AUTHFN_SECRET", "OAUTH_TOKEN_PEPPER", "TURNSTILE_SECRET_KEY"],
  },
  mcp: {
    name: "skillplane-mcp-dev",
    host: "mcp-dev.skillplane.dev",
    directory: resolve(root, "mcp"),
    config: resolve(root, "mcp", "wrangler.development.generated.json"),
    template: resolve(root, "deployment", "wrangler", "mcp.development.json"),
    secrets: ["OAUTH_TOKEN_PEPPER"],
  },
});

export function requireDevelopmentHyperdriveId(
  value = process.env.CLOUDFLARE_DEV_HYPERDRIVE_ID,
) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[a-f0-9]{32}$/u.test(normalized)) {
    throw new Error(
      "CLOUDFLARE_DEV_HYPERDRIVE_ID must be a 32-character Hyperdrive ID",
    );
  }
  if (normalized === process.env.CLOUDFLARE_HYPERDRIVE_ID?.trim().toLowerCase()) {
    throw new Error(
      "CLOUDFLARE_DEV_HYPERDRIVE_ID must differ from CLOUDFLARE_HYPERDRIVE_ID",
    );
  }
  return normalized;
}

export function developmentDatabase() {
  const parsed = parseDirectPostgresUrl(
    requireEnvironment("SKILLPLANE_DEV_DATABASE_URL"),
    "SKILLPLANE_DEV_DATABASE_URL",
  );
  const production =
    process.env.SKILLPLANE_PRODUCTION_DATABASE_URL?.trim() ??
    process.env.RAILWAY_DATABASE_URL?.trim();
  if (
    production &&
    parsed.fingerprint === parseDirectPostgresUrl(production).fingerprint
  ) {
    throw new Error("Development and production database identities must be different");
  }
  return parsed;
}

export function developmentSecrets() {
  const values = {
    AUTHFN_SECRET: requireSecretEnvironment("SKILLPLANE_DEV_AUTHFN_SECRET"),
    OAUTH_TOKEN_PEPPER: requireSecretEnvironment("SKILLPLANE_DEV_OAUTH_TOKEN_PEPPER"),
    TURNSTILE_SECRET_KEY: requireSecretEnvironment(
      "SKILLPLANE_DEV_TURNSTILE_SECRET_KEY",
    ),
  };
  if (new Set(Object.values(values)).size !== Object.keys(values).length) {
    throw new Error("Development secrets must use independent values");
  }
  for (const [name, value] of Object.entries(values)) {
    const productionValue = process.env[name];
    if (productionValue !== undefined && value === productionValue) {
      throw new Error(`SKILLPLANE_DEV_${name} must differ from production ${name}`);
    }
  }
  return values;
}

export function developmentSiteKey() {
  const value = requireEnvironment("PUBLIC_DEV_TURNSTILE_SITE_KEY", {
    minimumLength: 10,
  });
  if (
    process.env.PUBLIC_TURNSTILE_SITE_KEY !== undefined &&
    value === process.env.PUBLIC_TURNSTILE_SITE_KEY
  ) {
    throw new Error(
      "PUBLIC_DEV_TURNSTILE_SITE_KEY must differ from production PUBLIC_TURNSTILE_SITE_KEY",
    );
  }
  return value;
}

export function developmentCloudflareEnvironment() {
  const token = requireSecretEnvironment("SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN");
  for (const name of ["CLOUDFLARE_API_TOKEN"]) {
    if (process.env[name] !== undefined && token === process.env[name]) {
      throw new Error(`SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN must differ from ${name}`);
    }
  }
  const environment = { ...process.env, CLOUDFLARE_API_TOKEN: token };
  for (const name of [
    "SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN",
    "SKILLPLANE_DEV_AUTHFN_SECRET",
    "SKILLPLANE_DEV_OAUTH_TOKEN_PEPPER",
    "SKILLPLANE_DEV_TURNSTILE_SECRET_KEY",
    "SKILLPLANE_DEV_DATABASE_URL",
    "SKILLPLANE_PRODUCTION_DATABASE_URL",
    "AUTHFN_SECRET",
    "OAUTH_TOKEN_PEPPER",
    "TURNSTILE_SECRET_KEY",
    "RAILWAY_DATABASE_URL",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
  ]) {
    Reflect.deleteProperty(environment, name);
  }
  return environment;
}

export async function renderDevelopmentConfigs(options = {}) {
  const hyperdriveId = requireDevelopmentHyperdriveId(options.hyperdriveId);
  const siteKey = options.siteKey ?? developmentSiteKey();
  const rendered = {};
  for (const [kind, worker] of Object.entries(developmentWorkers)) {
    const template = JSON.parse(await readFile(worker.template, "utf8"));
    const config = {
      ...template,
      $schema: options.absoluteEntryPaths
        ? resolve(root, "node_modules", "wrangler", "config-schema.json")
        : "../node_modules/wrangler/config-schema.json",
      ...(options.absoluteEntryPaths
        ? {
            main: resolve(worker.directory, template.main),
            ...(template.assets
              ? {
                  assets: {
                    ...template.assets,
                    directory: resolve(worker.directory, template.assets.directory),
                  },
                }
              : {}),
          }
        : {}),
      hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdriveId }],
      vars: {
        ...template.vars,
        ...(kind === "app" ? { PUBLIC_TURNSTILE_SITE_KEY: siteKey } : {}),
      },
    };
    assertDevelopmentConfig(kind, config, hyperdriveId);
    if (options.write !== false) {
      await writeJsonAtomic(options.outputPaths?.[kind] ?? worker.config, config, {
        mode: 0o600,
      });
    }
    rendered[kind] = config;
  }
  return { ok: true, environment: "development", hyperdriveId, configs: rendered };
}

export function assertDevelopmentConfig(kind, config, hyperdriveId) {
  const worker = developmentWorkers[kind];
  if (
    !worker ||
    config.name !== worker.name ||
    config.workers_dev !== false ||
    config.routes?.length !== 1 ||
    config.routes[0]?.pattern !== worker.host ||
    config.routes[0]?.custom_domain !== true ||
    config.r2_buckets?.[0]?.bucket_name !== developmentBucket ||
    config.hyperdrive?.[0]?.id !== hyperdriveId ||
    config.vars?.RUNTIME_ENV !== "preview" ||
    config.vars?.OAUTH_ISSUER !== developmentIssuer ||
    config.vars?.OAUTH_RESOURCE !== developmentResource ||
    "DATABASE_URL" in (config.vars ?? {})
  ) {
    throw new Error(`The ${kind} development configuration is not isolated`);
  }
  if (
    kind === "app" &&
    (config.vars?.AUTH_MODE !== "otp" ||
      config.vars?.TURNSTILE_ALLOWED_HOSTNAMES !== worker.host ||
      config.send_email?.[0]?.name !== "SEND_EMAIL")
  ) {
    throw new Error("The app development authentication bindings are incomplete");
  }
  if (kind === "mcp" && config.send_email !== undefined) {
    throw new Error("The MCP development Worker must not receive email bindings");
  }
}

function parseHyperdrive(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start)
    throw new Error("Hyperdrive lookup returned invalid JSON");
  return JSON.parse(output.slice(start, end + 1));
}

export function verifyDevelopmentHyperdrive(
  database = developmentDatabase(),
  options = {},
) {
  const id = requireDevelopmentHyperdriveId();
  const record = parseHyperdrive(
    captureWrangler(["hyperdrive", "get", id], options).stdout,
  );
  const origin = record.origin ?? {};
  if (
    record.id !== id ||
    origin.host?.toLowerCase() !== database.identity.host ||
    String(origin.port ?? "5432") !== database.identity.port ||
    origin.database !== database.identity.database ||
    origin.user !== database.identity.username ||
    record.caching?.disabled !== true
  ) {
    throw new Error(
      "The development Hyperdrive does not match the isolated dev database",
    );
  }
  return { id, databaseFingerprint: database.fingerprint, queryCacheDisabled: true };
}

function bucketNames(output) {
  return [...output.matchAll(/^name:\s+([^\s]+)\s*$/gmu)].map((match) => match[1]);
}

export function ensureDevelopmentBucket(options = {}) {
  const listed = captureWrangler(["r2", "bucket", "list"], options).stdout;
  let created = false;
  if (!bucketNames(listed).includes(developmentBucket)) {
    run("pnpm", ["exec", "wrangler", "r2", "bucket", "create", developmentBucket], {
      env: options.env,
    });
    created = true;
  }
  const privacy = assertPrivateDevelopmentBucket(
    captureWrangler(["r2", "bucket", "dev-url", "get", developmentBucket], options)
      .stdout,
    captureWrangler(["r2", "bucket", "domain", "list", developmentBucket], options)
      .stdout,
  );
  return { name: developmentBucket, created, ...privacy };
}

export function assertPrivateDevelopmentBucket(devUrl, domains) {
  if (!/public access .* is disabled/iu.test(devUrl)) {
    throw new Error("The development R2 r2.dev URL must remain disabled");
  }
  if (!/no custom domains/iu.test(domains)) {
    throw new Error("The development R2 bucket must not expose a custom domain");
  }
  return { private: true, r2DevDisabled: true, customDomainCount: 0 };
}

async function withDevelopmentSecrets(kind, operation) {
  const all = developmentSecrets();
  const secrets = Object.fromEntries(
    developmentWorkers[kind].secrets.map((name) => [name, all[name]]),
  );
  const path = resolve(
    developmentStateDirectory,
    `secrets-${kind}-${randomUUID()}.json`,
  );
  await writeJsonAtomic(path, secrets, { mode: 0o600 });
  try {
    return await operation(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

export async function deployDevelopment() {
  const commit = capture("git", ["rev-parse", "HEAD"]).stdout.trim();
  const changes = capture("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]).stdout.trim();
  if (changes)
    throw new Error("Development deployment requires a committed clean worktree");
  const cloudflareEnvironment = developmentCloudflareEnvironment();
  const database = developmentDatabase();
  await renderDevelopmentConfigs();
  captureWrangler(["whoami"], { env: cloudflareEnvironment });
  const hyperdrive = verifyDevelopmentHyperdrive(database, {
    env: cloudflareEnvironment,
  });
  const bucket = ensureDevelopmentBucket({ env: cloudflareEnvironment });
  const buildEnvironment = { ...cloudflareEnvironment };
  delete buildEnvironment.CLOUDFLARE_API_TOKEN;
  run("pnpm", ["build"], {
    env: buildEnvironment,
    failureMessage: "Development monorepo build failed",
  });
  const deployed = {};
  for (const [kind, worker] of Object.entries(developmentWorkers)) {
    deployed[kind] = await withDevelopmentSecrets(kind, async (secretFile) => {
      run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--config",
          worker.config,
          "--strict",
          "--secrets-file",
          secretFile,
          "--message",
          `Skillplane development ${commit.slice(0, 12)}`,
        ],
        {
          cwd: worker.directory,
          env: cloudflareEnvironment,
          failureMessage: `${worker.name} deployment failed`,
        },
      );
      return { worker: worker.name, host: worker.host };
    });
  }
  return {
    ok: true,
    environment: "development",
    commit,
    database: database.fingerprint,
    hyperdrive,
    bucket,
    workers: deployed,
  };
}
