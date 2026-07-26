#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(repoRoot, "../../..");

const EXIT = Object.freeze({
  USAGE: 2,
  NODE_UNSUPPORTED: 10,
  PNPM_MISSING: 11,
  PNPM_UNSUPPORTED: 12,
  DOCKER_MISSING: 20,
  DOCKER_UNAVAILABLE: 21,
  POSTGRES_PORT_INVALID: 22,
  POSTGRES_PORT_OCCUPIED: 23,
  WORKTREE_MISSING: 30,
  WORKTREE_INVALID: 31,
  SOURCE_PACKAGE_MISSING: 32,
  EXTERNAL_WORKTREE_OVERLAP: 33,
  PORTABILITY_VIOLATION: 40,
  BASELINE_WRITE_FAILED: 41,
  SELF_TEST_FAILED: 50,
});

const ERROR_CODES = Object.freeze(
  Object.fromEntries(Object.entries(EXIT).map(([name, value]) => [value, name])),
);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".wrangler",
  "blob-report",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const PORTABILITY_PATTERNS = [
  {
    code: "MACOS_HOME_PATH",
    pattern: new RegExp(
      String.raw`(?:^|[\s"'(=])\/` + "Users" + String.raw`\/[^/\s]+(?:\/|$)`,
      "u",
    ),
  },
  {
    code: "LINUX_HOME_PATH",
    pattern: new RegExp(
      String.raw`(?:^|[\s"'(=])\/` + "home" + String.raw`\/[^/\s]+(?:\/|$)`,
      "u",
    ),
  },
  { code: "WINDOWS_HOME_PATH", pattern: /[A-Za-z]:\\Users\\[^\\\s]+\\/u },
  {
    code: "FILE_URI",
    pattern: new RegExp("file:" + String.raw`\/\/`, "u"),
  },
];

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(code, message, details = undefined) {
  const exitCode = EXIT[code] ?? EXIT.USAGE;
  emit({
    ok: false,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  });
  process.exit(exitCode);
}

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version.trim());
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function isSupportedNode(version) {
  const parsed = parseVersion(version);
  if (!parsed) {
    return false;
  }

  return (
    (parsed.major === 20 && parsed.minor >= 19) ||
    parsed.major === 22 ||
    parsed.major === 24
  );
}

function isSupportedPnpm(version) {
  const parsed = parseVersion(version);
  return parsed?.major === 11;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readArg(name, defaultValue) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return defaultValue;
  }

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail("USAGE", `${name} requires a value`);
  }
  return value;
}

async function pathExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function validateChangedPath(path) {
  const normalized = path.replace(/^"(.*)"$/u, "$1");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split(/[/\\]/u).includes("..") ||
    /^[A-Za-z]:\\/u.test(normalized)
  ) {
    throw new Error("Git returned a non-relative changed path");
  }
  return normalized;
}

function changedPaths(root) {
  const output = run(
    "git",
    ["-c", "core.quotepath=false", "status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root },
  );

  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => validateChangedPath(line.slice(3)))
    .sort((left, right) => left.localeCompare(right));
}

async function inspectWorktree(definition) {
  if (!(await pathExists(definition.root))) {
    fail("WORKTREE_MISSING", `${definition.label} worktree is missing`, {
      label: definition.label,
      override: definition.override,
    });
  }

  let branch;
  let commit;
  let changes;
  try {
    branch = run("git", ["branch", "--show-current"], {
      cwd: definition.root,
    });
    commit = run("git", ["rev-parse", "HEAD"], { cwd: definition.root });
    changes = changedPaths(definition.root);
  } catch {
    fail("WORKTREE_INVALID", `${definition.label} is not a readable Git worktree`, {
      label: definition.label,
    });
  }

  return {
    label: definition.label,
    branch: branch || "detached",
    commit,
    dirty: changes.length > 0,
    changedPaths: changes,
  };
}

async function verifySourcePackages(definitions) {
  const missing = [];
  for (const definition of definitions) {
    for (const sourcePath of definition.requiredSourcePaths) {
      if (!(await pathExists(join(definition.root, sourcePath)))) {
        missing.push(`${definition.label}:${sourcePath}`);
      }
    }
  }

  if (missing.length > 0) {
    fail("SOURCE_PACKAGE_MISSING", "Required dependency source is missing", {
      missing,
    });
  }
}

function dockerVersions() {
  try {
    const value = run("docker", [
      "version",
      "--format",
      "{{.Client.Version}}|{{.Server.Version}}",
    ]);
    const [client, server] = value.split("|");
    if (!client || !server) {
      fail("DOCKER_UNAVAILABLE", "Docker engine returned an incomplete version");
    }
    return { client, server };
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("DOCKER_MISSING", "Docker CLI is unavailable");
    }
    fail("DOCKER_UNAVAILABLE", "Docker engine is unavailable");
  }
}

function parsePostgresPort(rawPort) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    fail(
      "POSTGRES_PORT_INVALID",
      "SKILLPLANE_POSTGRES_PORT must be an integer from 1024 to 65535",
    );
  }
  return port;
}

async function assertPortAvailable(port) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();

    server.once("error", (error) => {
      rejectPromise(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
  }).catch((error) => {
    if (error?.code === "EADDRINUSE") {
      fail("POSTGRES_PORT_OCCUPIED", `SKILLPLANE_POSTGRES_PORT ${port} is occupied`, {
        variable: "SKILLPLANE_POSTGRES_PORT",
        port,
      });
    }
    fail("POSTGRES_PORT_OCCUPIED", "Postgres port availability check failed", {
      variable: "SKILLPLANE_POSTGRES_PORT",
      port,
      reason: error?.code ?? "UNKNOWN",
    });
  });
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, absolutePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function portabilityViolations() {
  const violations = [];
  for (const absolutePath of await walkFiles(repoRoot)) {
    const info = await stat(absolutePath);
    if (info.size > 2_000_000) {
      continue;
    }

    const content = await readFile(absolutePath, "utf8").catch(() => null);
    if (content === null || content.includes("\u0000")) {
      continue;
    }

    const lines = content.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const portabilityPattern of PORTABILITY_PATTERNS) {
        if (portabilityPattern.pattern.test(line)) {
          violations.push({
            path: relative(repoRoot, absolutePath).split(sep).join("/"),
            line: index + 1,
            code: portabilityPattern.code,
          });
        }
      }
    }
  }
  return violations;
}

async function checkPortability() {
  const violations = await portabilityViolations();
  if (violations.length > 0) {
    fail("PORTABILITY_VIOLATION", "Repository contains machine-specific paths", {
      violations,
    });
  }

  emit({ ok: true, mode: "portability", files: "repository-local" });
}

function dependencyDefinitions() {
  return [
    {
      label: "superfunctions-dev",
      override: "SKILLPLANE_SUPERFUNCTIONS_DEV_ROOT",
      root:
        process.env.SKILLPLANE_SUPERFUNCTIONS_DEV_ROOT ??
        join(workspaceRoot, "superfunctions-dev"),
      requiredSourcePaths: [
        "authfn/core/package.json",
        "datafn/client/package.json",
        "datafn/core/package.json",
        "datafn/server/package.json",
        "datafn/svelte/package.json",
      ],
    },
    {
      label: "superfunctions-next",
      override: "SKILLPLANE_SUPERFUNCTIONS_NEXT_ROOT",
      root:
        process.env.SKILLPLANE_SUPERFUNCTIONS_NEXT_ROOT ??
        join(workspaceRoot, "superfunctions"),
      requiredSourcePaths: [
        "sendfn/typescript/package.json",
        "sendfn/typescript/src/index.ts",
        "packages/delivery/package.json",
      ],
    },
    {
      label: "nucleus",
      override: "SKILLPLANE_NUCLEUS_ROOT",
      root: process.env.SKILLPLANE_NUCLEUS_ROOT ?? join(workspaceRoot, "nucleus"),
      requiredSourcePaths: [
        "services/account/package.json",
        "services/account/src/auth.ts",
        "services/account/src/datafn/server.ts",
      ],
    },
  ];
}

function sendFnOverlap(worktrees) {
  const next = worktrees.find((worktree) => worktree.label === "superfunctions-next");
  return (
    next?.changedPaths.filter(
      (path) => path.startsWith("sendfn/") || path.startsWith("packages/delivery/"),
    ) ?? []
  );
}

async function writeBaseline(worktrees) {
  const baselinePath = join(repoRoot, ".conduct", "dependency-baseline.json");
  const baseline = {
    worktrees: worktrees.map(
      ({ label, branch, commit, dirty, changedPaths: paths }) => ({
        label,
        branch,
        commit,
        dirty,
        changedPaths: paths,
      }),
    ),
  };

  try {
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    fail("BASELINE_WRITE_FAILED", "Dependency baseline could not be written");
  }
}

function selfTest() {
  try {
    assert.equal(isSupportedNode("v20.19.0"), true);
    assert.equal(isSupportedNode("22.22.1"), true);
    assert.equal(isSupportedNode("24.14.0"), true);
    assert.equal(isSupportedNode("v20.18.3"), false);
    assert.equal(isSupportedNode("23.0.0"), false);
    assert.equal(isSupportedPnpm("11.8.0"), true);
    assert.equal(isSupportedPnpm("10.0.0"), false);
    assert.equal(
      validateChangedPath("sendfn/typescript/src/index.ts"),
      "sendfn/typescript/src/index.ts",
    );
    assert.throws(() => validateChangedPath("/private/source.ts"));
    assert.throws(() => validateChangedPath("../source.ts"));
    assert.equal(ERROR_CODES[EXIT.POSTGRES_PORT_OCCUPIED], "POSTGRES_PORT_OCCUPIED");
  } catch (error) {
    fail("SELF_TEST_FAILED", "Preflight self-test failed", {
      assertion: error.message,
    });
  }

  emit({ ok: true, mode: "self-test", assertions: 11 });
}

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  if (process.argv.includes("--check-portability")) {
    await checkPortability();
    return;
  }

  const mode = readArg("--mode", "spec-safe");
  if (!["spec-safe", "superfunctions-edit"].includes(mode)) {
    fail("USAGE", "Unsupported preflight mode", {
      allowed: ["spec-safe", "superfunctions-edit"],
    });
  }

  const nodeVersion = process.version;
  if (!isSupportedNode(nodeVersion)) {
    fail("NODE_UNSUPPORTED", "Node 20.19+, Node 22, or Node 24 is required", {
      current: nodeVersion,
    });
  }

  let pnpmVersion;
  try {
    pnpmVersion = run("pnpm", ["--version"]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("PNPM_MISSING", "pnpm is unavailable");
    }
    fail("PNPM_MISSING", "pnpm version could not be read");
  }

  if (!isSupportedPnpm(pnpmVersion)) {
    fail("PNPM_UNSUPPORTED", "pnpm 11 is required", {
      current: pnpmVersion,
    });
  }

  const docker = dockerVersions();
  const port = parsePostgresPort(process.env.SKILLPLANE_POSTGRES_PORT ?? "5432");
  await assertPortAvailable(port);

  const definitions = dependencyDefinitions();
  await verifySourcePackages(definitions);
  const worktrees = [];
  for (const definition of definitions) {
    worktrees.push(await inspectWorktree(definition));
  }

  const overlap = sendFnOverlap(worktrees);
  if (mode === "superfunctions-edit" && overlap.length > 0) {
    fail(
      "EXTERNAL_WORKTREE_OVERLAP",
      "Existing SendFn/delivery changes block Superfunctions edits",
      { changedPaths: overlap },
    );
  }

  if (process.argv.includes("--write-baseline")) {
    await writeBaseline(worktrees);
  }

  emit({
    ok: true,
    mode,
    runtime: {
      node: nodeVersion,
      pnpm: pnpmVersion,
      docker,
      postgresPort: port,
    },
    dependencies: worktrees.map(
      ({ label, branch, commit, dirty, changedPaths: paths }) => ({
        label,
        branch,
        commit,
        dirty,
        changedPathCount: paths.length,
      }),
    ),
    superfunctionsEdit: {
      allowed: overlap.length === 0,
      code: overlap.length === 0 ? null : "EXTERNAL_WORKTREE_OVERLAP",
      changedPaths: overlap,
    },
    baselineWritten: process.argv.includes("--write-baseline"),
  });
}

await main();
