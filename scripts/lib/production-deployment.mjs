import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const productionStateDirectory = resolve(root, ".data", "production");
export const productionBucket = "skillplane-skill-bundles";
export const productionIssuer = "https://app.skillplane.dev";
export const productionResource = "https://mcp.skillplane.dev/mcp";

export const workers = Object.freeze({
  app: {
    name: "skillplane-app",
    directory: resolve(root, "app"),
    config: resolve(root, "app", "wrangler.generated.json"),
    host: "app.skillplane.dev",
    secretNames: ["AUTHFN_SECRET", "OAUTH_TOKEN_PEPPER", "TURNSTILE_SECRET_KEY"],
  },
  mcp: {
    name: "skillplane-mcp",
    directory: resolve(root, "mcp"),
    config: resolve(root, "mcp", "wrangler.generated.json"),
    host: "mcp.skillplane.dev",
    secretNames: ["OAUTH_TOKEN_PEPPER"],
  },
});

const libpqCompatHosts = new Set(["insouth.db.21n.dev"]);
const hyperdriveIdPattern = /^[a-f0-9]{32}$/u;
const versionIdPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

export function portablePath(path) {
  return relative(root, path).split(sep).join("/") || ".";
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function isMain(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(process.argv[1]).href;
}

export function requireEnvironment(name, options = {}) {
  const raw = process.env[name];
  const value = options.trim === false ? raw : raw?.trim();
  const minimumLength = options.minimumLength ?? 1;
  if (!value || !value.trim() || value.length < minimumLength) {
    throw new Error(
      `${name} is required${minimumLength > 1 ? ` and must contain at least ${minimumLength} characters` : ""}`,
    );
  }
  if (options.pattern && !options.pattern.test(value)) {
    throw new Error(`${name} has an invalid format`);
  }
  return value;
}

export function requireHyperdriveId(value = process.env.CLOUDFLARE_HYPERDRIVE_ID) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !hyperdriveIdPattern.test(normalized)) {
    throw new Error(
      "CLOUDFLARE_HYPERDRIVE_ID must be the 32-character ID for the Skillplane production Hyperdrive configuration",
    );
  }
  return normalized;
}

const turnstileTestKeyPattern = /^[123]x0{10,}/iu;

export function requireSecretEnvironment(name) {
  const value = requireEnvironment(name, {
    minimumLength: 32,
    trim: false,
  });
  if (
    new Set(value).size < 10 ||
    /(?:change[-_ ]?me|placeholder|not[-_ ]?for[-_ ]?production)/iu.test(value)
  ) {
    throw new Error(`${name} does not meet the production secret quality policy`);
  }
  return value;
}

export function productionSecrets() {
  const secrets = {
    AUTHFN_SECRET: requireSecretEnvironment("AUTHFN_SECRET"),
    OAUTH_TOKEN_PEPPER: requireSecretEnvironment("OAUTH_TOKEN_PEPPER"),
    TURNSTILE_SECRET_KEY: requireSecretEnvironment("TURNSTILE_SECRET_KEY"),
  };
  if (new Set(Object.values(secrets)).size !== Object.keys(secrets).length) {
    throw new Error("Production secrets must be independent values");
  }
  if (turnstileTestKeyPattern.test(secrets.TURNSTILE_SECRET_KEY)) {
    throw new Error("TURNSTILE_SECRET_KEY must not be a Cloudflare testing key");
  }
  return secrets;
}

export function productionSecretsForWorker(worker) {
  if (worker.name === workers.app.name) {
    return productionSecrets();
  }
  return Object.fromEntries(
    worker.secretNames.map((name) => [name, requireSecretEnvironment(name)]),
  );
}

export function publicTurnstileSiteKey() {
  const value = requireEnvironment("PUBLIC_TURNSTILE_SITE_KEY", {
    minimumLength: 10,
  });
  if (turnstileTestKeyPattern.test(value)) {
    throw new Error("PUBLIC_TURNSTILE_SITE_KEY must not be a Cloudflare testing key");
  }
  return value;
}

export function parseDirectPostgresUrl(raw, source = "Direct PostgreSQL URL") {
  if (!raw) {
    throw new Error(`${source} is required`);
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${source} is not a valid URL`);
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  const normalizedHost = parsed.hostname.toLowerCase();
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !normalizedHost ||
    !parsed.username ||
    !parsed.password ||
    !database ||
    database.includes("/") ||
    parsed.hash
  ) {
    throw new Error(
      `${source} must be a complete PostgreSQL URL with host, credentials, and database name`,
    );
  }
  const sslMode = parsed.searchParams.get("sslmode");
  if (sslMode && !["require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new Error(`${source} must not weaken SSL`);
  }
  if (!sslMode) parsed.searchParams.set("sslmode", "require");
  // PostgreSQL 17 accepts `sslrootcert=system`, but node-postgres treats every
  // sslrootcert value as a filesystem path. Omitting this provider hint keeps
  // verify-full enabled while using Node's trusted system CA set.
  if (parsed.searchParams.get("sslrootcert") === "system") {
    parsed.searchParams.delete("sslrootcert");
  }
  if (libpqCompatHosts.has(normalizedHost)) {
    parsed.searchParams.set("uselibpqcompat", "true");
  }
  const identity = {
    host: normalizedHost,
    port: parsed.port || "5432",
    database,
    username: decodeURIComponent(parsed.username),
  };
  return {
    url: parsed.toString(),
    password: decodeURIComponent(parsed.password),
    identity,
    fingerprint: sha256(
      JSON.stringify({
        host: identity.host,
        port: identity.port,
        database: identity.database,
      }),
    ),
  };
}

export function postgresTlsEvidence(client, serverRow = {}) {
  const stream = client?.connection?.stream;
  const clientEncrypted = stream?.encrypted === true;
  const certificateAuthorized = stream?.authorized === true;
  const serverReportedEncrypted = serverRow?.ssl === true;
  if (!clientEncrypted || (!certificateAuthorized && !serverReportedEncrypted)) {
    throw new Error(
      "The PostgreSQL client connection is not protected by verified TLS",
    );
  }
  const clientCipher =
    typeof stream.getCipher === "function" ? stream.getCipher() : undefined;
  const protocol =
    serverRow?.version ??
    (typeof stream.getProtocol === "function" ? stream.getProtocol() : undefined) ??
    "unknown";
  const cipher =
    serverRow?.cipher ?? clientCipher?.standardName ?? clientCipher?.name ?? "unknown";
  const serverBits = Number(serverRow?.bits ?? 0);
  const inferredBits = cipher.includes("_256_")
    ? 256
    : cipher.includes("_128_")
      ? 128
      : 0;
  return {
    enabled: true,
    certificateAuthorized,
    serverReportedEncrypted,
    protocol,
    cipher,
    bits: serverBits > 0 ? serverBits : inferredBits,
  };
}

export function productionDatabase() {
  const canonical = process.env.SKILLPLANE_PRODUCTION_DATABASE_URL?.trim();
  const legacy = process.env.RAILWAY_DATABASE_URL?.trim();
  if (canonical && legacy) {
    const canonicalDatabase = parseDirectPostgresUrl(
      canonical,
      "SKILLPLANE_PRODUCTION_DATABASE_URL",
    );
    const legacyDatabase = parseDirectPostgresUrl(
      legacy,
      "legacy RAILWAY_DATABASE_URL",
    );
    if (canonicalDatabase.fingerprint !== legacyDatabase.fingerprint) {
      throw new Error(
        "SKILLPLANE_PRODUCTION_DATABASE_URL conflicts with legacy RAILWAY_DATABASE_URL",
      );
    }
    return canonicalDatabase;
  }
  return parseDirectPostgresUrl(
    canonical ?? legacy ?? process.env.MIGRATION_DATABASE_URL?.trim(),
    canonical
      ? "SKILLPLANE_PRODUCTION_DATABASE_URL"
      : legacy
        ? "legacy RAILWAY_DATABASE_URL"
        : "SKILLPLANE_PRODUCTION_DATABASE_URL for direct production backup and migration",
  );
}

export function productionMigrationSourceDatabase() {
  return parseDirectPostgresUrl(
    requireEnvironment("SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL"),
    "SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL",
  );
}

export function run(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    input: options.input,
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 1024,
    stdio: options.stdio ?? ["inherit", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      options.failureMessage ??
        `${command} ${arguments_.slice(0, 3).join(" ")} failed with exit code ${result.status ?? "unknown"}`,
    );
  }
  return result;
}

export function capture(command, arguments_, options = {}) {
  const result = run(command, arguments_, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

export function wrangler(arguments_, options = {}) {
  return run("pnpm", ["exec", "wrangler", ...arguments_], options);
}

export function captureWrangler(arguments_, options = {}) {
  return capture("pnpm", ["exec", "wrangler", ...arguments_], options);
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function pathExists(path) {
  return access(path)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
}

export async function writeJsonAtomic(path, value, options = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (options.exclusive && (await pathExists(path))) {
    throw new Error(`Refusing to overwrite append-only artifact ${portablePath(path)}`);
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: options.mode ?? 0o600,
    });
    if (options.exclusive && (await pathExists(path))) {
      throw new Error(
        `Refusing to overwrite append-only artifact ${portablePath(path)}`,
      );
    }
    await rename(temporary, path);
    await chmod(path, options.mode ?? 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function withSecretFile(secrets, operation) {
  const path = resolve(productionStateDirectory, `worker-secrets-${randomUUID()}.json`);
  await writeJsonAtomic(path, secrets, { mode: 0o600 });
  try {
    return await operation(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

export function activeVersionFromDeployments(deployments) {
  if (!Array.isArray(deployments)) return null;
  // Wrangler sorts `deployments list --json` oldest-to-newest, so the last
  // deployment is the one currently serving traffic.
  for (const deployment of deployments.toReversed()) {
    if (!deployment || typeof deployment !== "object") continue;
    const versions = deployment.versions;
    if (!Array.isArray(versions)) continue;
    const active = versions.find(
      (version) =>
        version &&
        typeof version === "object" &&
        typeof version.version_id === "string" &&
        Number(version.percentage) === 100,
    );
    if (active && versionIdPattern.test(active.version_id)) {
      return active.version_id;
    }
  }
  return null;
}

export function listDeployments(worker, options = {}) {
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "deployments", "list", "--name", worker.name, "--json"],
    {
      cwd: worker.directory,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (
      options.allowMissing &&
      /does not exist|not found|could not find|no deployments/iu.test(output)
    ) {
      return [];
    }
    throw new Error(`Could not read deployments for ${worker.name}`);
  }
  return parseJsonOutput(result.stdout, `${worker.name} deployments`);
}

export function activeWorkerVersion(worker, options = {}) {
  const deployments = listDeployments(worker, options);
  const active = activeVersionFromDeployments(deployments);
  if (deployments.length > 0 && !active) {
    throw new Error(
      `${worker.name} is using split traffic; production deployment requires one version at 100%`,
    );
  }
  return active;
}

export function validateVersionId(value, label = "Worker version") {
  if (typeof value !== "string" || !versionIdPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function productionReleaseTag() {
  const configured = process.env.SKILLPLANE_RELEASE_TAG?.trim();
  if (configured) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,53}$/u.test(configured)) {
      throw new Error("SKILLPLANE_RELEASE_TAG has an invalid format");
    }
    return configured;
  }
  return `phase16-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`;
}

export function requireCleanSourceRevision() {
  const commit = capture("git", ["rev-parse", "HEAD"], {
    failureMessage: "Production deployment requires a Git source revision",
  }).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
    throw new Error("The Git source revision is invalid");
  }
  const changes = capture(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "."],
    { failureMessage: "Could not verify the production source worktree" },
  ).stdout.trim();
  if (changes) {
    throw new Error(
      "Production deployment requires the complete Skillplane source to be committed with a clean worktree",
    );
  }
  return { commit, clean: true };
}

export async function assertRecentDatabaseSafetyState() {
  const database = productionDatabase();
  let backup;
  let migration;
  try {
    backup = await readJson(resolve(productionStateDirectory, "backup.json"));
    migration = await readJson(resolve(productionStateDirectory, "migration.json"));
  } catch {
    throw new Error(
      "Verified production backup and migration safety records are required before deployment",
    );
  }
  for (const [name, state, maximumAge] of [
    ["backup", backup, 24 * 60 * 60 * 1000],
    ["migration", migration, 2 * 60 * 60 * 1000],
  ]) {
    const createdAt = Date.parse(state.createdAt);
    if (
      state.ok !== true ||
      state.databaseFingerprint !== database.fingerprint ||
      !Number.isFinite(createdAt) ||
      Date.now() - createdAt < 0 ||
      Date.now() - createdAt > maximumAge
    ) {
      throw new Error(
        `The production ${name} safety state is absent, stale, or belongs to another database`,
      );
    }
  }
  if (Date.parse(backup.createdAt) > Date.parse(migration.createdAt)) {
    throw new Error("The production backup must precede the verified migration");
  }
  if (
    typeof backup.encryptedSha256 !== "string" ||
    migration.backupSha256 !== backup.encryptedSha256 ||
    migration.backupCreatedAt !== backup.createdAt
  ) {
    throw new Error("The migration safety record does not match the production backup");
  }
  return { database, backup, migration };
}

export function sanitizeDeploymentRecord(record) {
  return JSON.parse(
    JSON.stringify(record, (key, value) => {
      if (
        key !== "secretNames" &&
        /(?:secret|password|token|authorization|cookie|databaseUrl|connectionString)/iu.test(
          key,
        )
      ) {
        return "[redacted]";
      }
      return value;
    }),
  );
}
