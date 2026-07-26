#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = join(repoRoot, ".data");
const runtimePath = join(dataDirectory, "local-runtime.json");
const composePath = join(repoRoot, "docker-compose.yml");
const containerName = "skillplane-postgres";
const volumeName = "skillplane_postgres_data";
const image =
  "postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193";

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(code, message, exitCode, details = undefined) {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
      null,
      2,
    )}\n`,
  );
  process.exit(exitCode);
}

function run(command, args, environment = process.env) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    fail(
      "POSTGRES_PORT_INVALID",
      "SKILLPLANE_POSTGRES_PORT must be an integer from 1024 to 65535",
      22,
    );
  }
  return port;
}

async function isPortAvailable(port) {
  return await new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

function containerExists() {
  try {
    run("docker", ["inspect", containerName]);
    return true;
  } catch {
    return false;
  }
}

function containerIsRunning() {
  if (!containerExists()) {
    return false;
  }
  return (
    run("docker", ["inspect", "--format", "{{.State.Running}}", containerName]) ===
    "true"
  );
}

async function readRuntime() {
  try {
    const parsed = JSON.parse(await readFile(runtimePath, "utf8"));
    if (
      typeof parsed.port !== "number" ||
      typeof parsed.database !== "string" ||
      typeof parsed.user !== "string" ||
      typeof parsed.password !== "string" ||
      typeof parsed.databaseUrl !== "string"
    ) {
      fail("LOCAL_RUNTIME_INVALID", "Local runtime configuration is invalid", 24);
    }
    return parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      fail("LOCAL_RUNTIME_INVALID", "Local runtime configuration is unreadable", 24);
    }
    return null;
  }
}

async function createRuntime(port) {
  const user = "skillplane_app";
  const database = "skillplane";
  const password = randomBytes(32).toString("base64url");
  const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@127.0.0.1:${port}/${database}`;
  const testDatabase = "skillplane_test";
  const testDatabaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password,
  )}@127.0.0.1:${port}/${testDatabase}`;
  const runtime = {
    port,
    database,
    testDatabase,
    user,
    password,
    databaseUrl,
    testDatabaseUrl,
  };

  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return runtime;
}

async function writeWorkerDevelopmentVariables(runtime) {
  const value = [
    "RUNTIME_ENV=local",
    "DATABASE_ADAPTER=postgres",
    `DATABASE_URL=${runtime.databaseUrl}`,
    "",
  ].join("\n");

  for (const workspace of ["app", "mcp"]) {
    await writeFile(join(repoRoot, workspace, ".dev.vars"), value, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

let runtime = await readRuntime();
const requestedPort = parsePort(
  process.env.SKILLPLANE_POSTGRES_PORT ?? String(runtime?.port ?? 5432),
);

if (runtime && runtime.port !== requestedPort) {
  fail(
    "POSTGRES_PORT_CONFIG_MISMATCH",
    "Configured port differs from the persisted Skillplane runtime",
    25,
    { variable: "SKILLPLANE_POSTGRES_PORT", persistedPort: runtime.port },
  );
}

runtime ??= await createRuntime(requestedPort);

try {
  run("docker", ["version", "--format", "{{.Server.Version}}"]);
} catch {
  fail("DOCKER_UNAVAILABLE", "Docker engine is unavailable", 21);
}

if (!containerIsRunning() && !(await isPortAvailable(runtime.port))) {
  fail(
    "POSTGRES_PORT_OCCUPIED",
    `SKILLPLANE_POSTGRES_PORT ${runtime.port} is occupied`,
    23,
    { variable: "SKILLPLANE_POSTGRES_PORT", port: runtime.port },
  );
}

const composeEnvironment = {
  ...process.env,
  SKILLPLANE_POSTGRES_DATABASE: runtime.database,
  SKILLPLANE_POSTGRES_PASSWORD: runtime.password,
  SKILLPLANE_POSTGRES_PORT: String(runtime.port),
  SKILLPLANE_POSTGRES_USER: runtime.user,
};

try {
  run(
    "docker",
    [
      "compose",
      "--file",
      composePath,
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "60",
      "postgres",
    ],
    composeEnvironment,
  );
} catch {
  fail("POSTGRES_START_FAILED", "Postgres did not become healthy", 26);
}

await writeWorkerDevelopmentVariables(runtime);

emit({
  ok: true,
  container: containerName,
  volume: volumeName,
  image,
  host: "127.0.0.1",
  port: runtime.port,
  database: runtime.database,
  user: runtime.user,
  password: "redacted",
  health: "healthy",
});
