#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = join(repoRoot, ".data", "local-runtime.json");
const composePath = join(repoRoot, "docker-compose.yml");

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

let runtime;
try {
  runtime = JSON.parse(await readFile(runtimePath, "utf8"));
} catch (error) {
  if (error?.code === "ENOENT") {
    emit({
      ok: true,
      state: "already-down",
      volume: "skillplane_postgres_data",
      volumePreserved: true,
    });
    process.exit(0);
  }
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code: "LOCAL_RUNTIME_INVALID",
      message: "Local runtime configuration is unreadable",
    })}\n`,
  );
  process.exit(24);
}

const environment = {
  ...process.env,
  SKILLPLANE_POSTGRES_DATABASE: runtime.database,
  SKILLPLANE_POSTGRES_PASSWORD: runtime.password,
  SKILLPLANE_POSTGRES_PORT: String(runtime.port),
  SKILLPLANE_POSTGRES_USER: runtime.user,
};

try {
  execFileSync(
    "docker",
    ["compose", "--file", composePath, "down", "--remove-orphans"],
    {
      cwd: repoRoot,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code: "POSTGRES_STOP_FAILED",
      message: "Postgres could not be stopped cleanly",
    })}\n`,
  );
  process.exit(27);
}

emit({
  ok: true,
  state: "stopped",
  container: "skillplane-postgres",
  volume: "skillplane_postgres_data",
  volumePreserved: true,
});
