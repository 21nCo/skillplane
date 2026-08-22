import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  activeWorkerVersion,
  captureWrangler,
  pathExists,
  productionBucket,
  productionPostHogHost,
  productionPostHogProxyHost,
  productionReleaseTag,
  productionSecretsForWorker,
  portablePath,
  publicTurnstileSiteKey,
  requireHyperdriveId,
  requirePostHogProjectToken,
  root,
  run,
  validateVersionId,
  withSecretFile,
  workers,
  wrangler,
} from "./production-deployment.mjs";

function bucketNames(output) {
  return [...output.matchAll(/^name:\s+([^\s]+)\s*$/gmu)].map((match) => match[1]);
}

export function ensureCloudflareSession() {
  const output = captureWrangler(["whoami"]).stdout;
  if (!/logged in|associated with/iu.test(output)) {
    throw new Error("Wrangler is not authenticated to Cloudflare");
  }
}

export function assertHyperdriveOriginRecord(database, expectedIdentity) {
  const origin = database?.origin;
  const actual = {
    host: origin?.host?.trim().toLowerCase(),
    port: String(origin?.port ?? "5432"),
    database: origin?.database,
    username: origin?.user,
  };
  if (
    !database ||
    database.id !== requireHyperdriveId(database.id) ||
    actual.host !== expectedIdentity.host ||
    actual.port !== expectedIdentity.port ||
    actual.database !== expectedIdentity.database ||
    actual.username !== expectedIdentity.username
  ) {
    throw new Error(
      "CLOUDFLARE_HYPERDRIVE_ID does not target the configured Railway database",
    );
  }
  if (database.caching?.disabled !== true) {
    throw new Error(
      "The production Hyperdrive configuration must disable query caching for read-after-write and authorization consistency",
    );
  }
  return {
    id: database.id,
    railwayOriginMatched: true,
    queryCacheDisabled: true,
  };
}

export function parseWranglerJson(output, label = "Wrangler response") {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end < start) {
    throw new Error(`${label} did not contain a JSON object`);
  }
  try {
    return JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new Error(`${label} did not contain a valid JSON object`);
  }
}

export function verifyProductionHyperdrive(expectedIdentity) {
  const hyperdriveId = requireHyperdriveId();
  const output = captureWrangler(["hyperdrive", "get", hyperdriveId]).stdout;
  const database = parseWranglerJson(output, "Cloudflare Hyperdrive response");
  return assertHyperdriveOriginRecord(database, expectedIdentity);
}

export function ensureProductionBucket() {
  const listed = captureWrangler(["r2", "bucket", "list"]).stdout;
  let created = false;
  if (!bucketNames(listed).includes(productionBucket)) {
    wrangler(["r2", "bucket", "create", productionBucket]);
    created = true;
  }
  const readLifecycleActions = () => {
    const lifecycle = captureWrangler([
      "r2",
      "bucket",
      "lifecycle",
      "list",
      productionBucket,
    ]).stdout;
    return [...lifecycle.matchAll(/^action:\s+(.+)$/gmu)].map((match) =>
      match[1].trim(),
    );
  };
  let actions = readLifecycleActions();
  if (actions.length === 0) {
    wrangler([
      "r2",
      "bucket",
      "lifecycle",
      "add",
      productionBucket,
      "skillplane-abort-incomplete-multipart",
      "--abort-multipart-days",
      "7",
      "--force",
    ]);
    actions = readLifecycleActions();
  }
  if (
    actions.length === 0 ||
    actions.some(
      (action) => !/^Abort incomplete multipart uploads after \d+ days$/u.test(action),
    )
  ) {
    throw new Error(
      "The production R2 lifecycle contains an object expiry or storage transition rule",
    );
  }
  const devUrl = captureWrangler([
    "r2",
    "bucket",
    "dev-url",
    "get",
    productionBucket,
  ]).stdout;
  if (!/public access .* is disabled/iu.test(devUrl)) {
    throw new Error("The production R2 r2.dev URL must remain disabled");
  }
  const domains = captureWrangler([
    "r2",
    "bucket",
    "domain",
    "list",
    productionBucket,
  ]).stdout;
  if (!/no custom domains/iu.test(domains)) {
    throw new Error("The production R2 bucket must not expose a custom domain");
  }
  return {
    name: productionBucket,
    created,
    private: true,
    lifecycleActions: actions,
    r2DevDisabled: true,
    customDomainCount: 0,
  };
}

function packageName(kind) {
  return `@skillplane/${kind}`;
}

function deployArguments(worker, options) {
  const arguments_ = [
    "deploy",
    "--config",
    worker.config,
    "--strict",
    "--message",
    options.message,
    "--tag",
    options.tag,
  ];
  if (options.secretFile) {
    arguments_.push("--secrets-file", options.secretFile);
  }
  return arguments_;
}

function deployOnce(kind, options) {
  const worker = workers[kind];
  wrangler(deployArguments(worker, options), {
    cwd: worker.directory,
    failureMessage: `${worker.name} deployment failed`,
  });
  const version = activeWorkerVersion(worker);
  return validateVersionId(version, `${worker.name} deployed version`);
}

async function validateGeneratedConfig(kind) {
  const worker = workers[kind];
  if (!(await pathExists(worker.config))) {
    throw new Error(
      `${worker.config} is missing; render production configuration before deploying`,
    );
  }
  const config = JSON.parse(await readFile(worker.config, "utf8"));
  const route = config.routes?.[0];
  const routeIsValid = route?.pattern === worker.host && route.custom_domain === true;
  if (
    config.name !== worker.name ||
    config.workers_dev !== false ||
    config.routes?.length !== 1 ||
    !routeIsValid
  ) {
    throw new Error(`${worker.name} generated configuration is invalid`);
  }
  if (
    config.hyperdrive?.length !== 1 ||
    config.hyperdrive[0]?.binding !== "HYPERDRIVE" ||
    config.hyperdrive[0]?.id !== requireHyperdriveId() ||
    config.r2_buckets?.[0]?.bucket_name !== productionBucket ||
    "DATABASE_URL" in (config.vars ?? {})
  ) {
    throw new Error(`${worker.name} generated bindings are invalid`);
  }
  if (
    kind === "app" &&
    (config.send_email?.[0]?.name !== "SEND_EMAIL" ||
      config.vars?.AUTH_MODE !== "otp" ||
      config.vars?.PUBLIC_TURNSTILE_SITE_KEY !== publicTurnstileSiteKey())
  ) {
    throw new Error(`${worker.name} generated auth bindings are invalid`);
  }
  if (
    kind === "app" &&
    (config.vars?.PUBLIC_POSTHOG_KEY !== requirePostHogProjectToken() ||
      config.vars?.PUBLIC_POSTHOG_HOST !== productionPostHogProxyHost)
  ) {
    throw new Error(`${worker.name} generated PostHog bindings are invalid`);
  }
  if (
    kind === "mcp" &&
    (config.send_email !== undefined ||
      !config.rules?.some(
        (rule) =>
          rule.type === "Data" &&
          rule.globs?.includes("**/*.png") &&
          rule.globs?.includes("**/*.ico"),
      ) ||
      "AUTH_MODE" in (config.vars ?? {}) ||
      "EMAIL_PROVIDER" in (config.vars ?? {}) ||
      "PUBLIC_TURNSTILE_SITE_KEY" in (config.vars ?? {}) ||
      "TURNSTILE_ALLOWED_HOSTNAMES" in (config.vars ?? {}) ||
      "SKILLPLANE_OTP_FROM" in (config.vars ?? {}))
  ) {
    throw new Error(`${worker.name} has unnecessary authentication bindings`);
  }
  if (kind === "mcp" && config.vars?.POSTHOG_HOST !== productionPostHogHost) {
    throw new Error(`${worker.name} generated PostHog host is invalid`);
  }
}

export async function deployNamedWorker(kind, options = {}) {
  if (!(kind in workers)) throw new Error(`Unknown production Worker ${kind}`);
  const worker = workers[kind];
  await validateGeneratedConfig(kind);
  if (options.build !== false) {
    run("pnpm", ["--filter", packageName(kind), "build"], {
      failureMessage: `${worker.name} build failed`,
    });
  }
  const priorVersion = activeWorkerVersion(worker, { allowMissing: true });
  const tag = options.tag ?? productionReleaseTag();
  const deploy = async (secretFile) => {
    const firstVersion = deployOnce(kind, {
      tag: priorVersion ? tag : `${tag}-baseline`,
      message: priorVersion
        ? `Skillplane production release ${tag}`
        : `Skillplane production rollback baseline for ${tag}`,
      secretFile,
    });
    if (priorVersion) {
      return {
        worker: worker.name,
        host: worker.host,
        priorVersion,
        releaseVersion: firstVersion,
        baselineBootstrapped: false,
      };
    }
    const releaseVersion = deployOnce(kind, {
      tag,
      message: `Skillplane production release ${tag}`,
      secretFile,
    });
    if (firstVersion === releaseVersion) {
      throw new Error(`${worker.name} did not create a distinct release version`);
    }
    return {
      worker: worker.name,
      host: worker.host,
      priorVersion: firstVersion,
      releaseVersion,
      baselineBootstrapped: true,
    };
  };
  const record =
    worker.secretNames.length > 0
      ? await withSecretFile(productionSecretsForWorker(worker), deploy)
      : await deploy(undefined);
  return {
    ...record,
    deployedAt: new Date().toISOString(),
    tag,
    config: portablePath(resolve(root, kind, "wrangler.generated.json")),
  };
}
