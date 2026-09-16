import { captureWrangler, requireHyperdriveId } from "./production-deployment.mjs";

function bucketNames(output) {
  return [...output.matchAll(/^name:\s+([^\s]+)\s*$/gmu)].map((match) => match[1]);
}

export function ensureCloudflareSession() {
  const output = captureWrangler(["whoami"]).stdout;
  if (!/logged in|associated with/iu.test(output)) {
    throw new Error("Wrangler is not authenticated to Cloudflare");
  }
}

export function assertHyperdriveOriginRecord(
  database,
  expectedIdentity,
  label = "CLOUDFLARE_HYPERDRIVE_ID",
) {
  const origin = database?.origin;
  const actual = {
    host: origin?.host?.trim().toLowerCase(),
    port: String(origin?.port ?? "5432"),
    database: origin?.database,
  };
  if (
    !database ||
    database.id !== requireHyperdriveId(database.id) ||
    actual.host !== expectedIdentity.host ||
    actual.port !== expectedIdentity.port ||
    actual.database !== expectedIdentity.database
  ) {
    throw new Error(`${label} does not target the configured production database`);
  }
  if (database.caching?.disabled !== true) {
    throw new Error(
      "The production Hyperdrive configuration must disable query caching for read-after-write and authorization consistency",
    );
  }
  return {
    id: database.id,
    databaseOriginMatched: true,
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

export function verifyProductionHyperdriveById(hyperdriveId, expectedIdentity, label) {
  const id = requireHyperdriveId(hyperdriveId);
  const output = captureWrangler(["hyperdrive", "get", id]).stdout;
  const database = parseWranglerJson(output, "Cloudflare Hyperdrive response");
  return assertHyperdriveOriginRecord(database, expectedIdentity, label);
}

function productionBucketSafety(bucketName) {
  const listed = captureWrangler(["r2", "bucket", "list"]).stdout;
  if (!bucketNames(listed).includes(bucketName)) {
    throw new Error(`Production R2 bucket ${bucketName} does not exist`);
  }
  const lifecycle = captureWrangler([
    "r2",
    "bucket",
    "lifecycle",
    "list",
    bucketName,
  ]).stdout;
  const actions = [...lifecycle.matchAll(/^action:\s+(.+)$/gmu)].map((match) =>
    match[1].trim(),
  );
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
  const devUrl = captureWrangler(["r2", "bucket", "dev-url", "get", bucketName]).stdout;
  if (!/public access .* is disabled/iu.test(devUrl)) {
    throw new Error("The production R2 r2.dev URL must remain disabled");
  }
  const domains = captureWrangler([
    "r2",
    "bucket",
    "domain",
    "list",
    bucketName,
  ]).stdout;
  if (!/no custom domains/iu.test(domains)) {
    throw new Error("The production R2 bucket must not expose a custom domain");
  }
  return {
    name: bucketName,
    private: true,
    lifecycleActions: actions,
    r2DevDisabled: true,
    customDomainCount: 0,
  };
}

export function verifyPrivateProductionBucket(bucketName) {
  return productionBucketSafety(bucketName);
}
