#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings = [];
const scanned = {
  productionSourceFiles: 0,
  productionBundleFiles: 0,
  packageManifests: 0,
  bundleBytes: 0,
};
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svelte",
  ".ts",
  ".yaml",
  ".yml",
]);
const ignoredDirectories = new Set([
  ".conduct",
  ".data",
  ".git",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "dist-worker",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const sourceRoots = ["app/src", "mcp/src", "packages"];
const bundleRoots = [
  "app/.svelte-kit/output/client",
  "app/.svelte-kit/output/server",
  "mcp/dist",
];
const sensitiveEnvironmentKeys = [
  "AUTHFN_SECRET",
  "OAUTH_TOKEN_PEPPER",
  "RAILWAY_DATABASE_URL",
  "TURNSTILE_SECRET_KEY",
];

async function exists(path) {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

async function walk(path, options = {}) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      if (options.ignoreBuildDirectories && ignoredDirectories.has(entry.name))
        continue;
      files.push(...(await walk(child, options)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

function addFinding(code, path, detail) {
  findings.push({
    code,
    path: path ? relative(root, path).replaceAll("\\", "/") : null,
    detail,
  });
}

function inspectRuntimeSource(path, content) {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.includes("/packages/testing/") ||
    normalized.includes("/tests/") ||
    /\.(?:test|spec)\.[cm]?[jt]s$/u.test(normalized)
  ) {
    return;
  }
  scanned.productionSourceFiles += 1;
  for (const pattern of [
    /from\s+["']@skillplane\/testing["']/gu,
    /import\s*\(\s*["'][^"']*\/tests(?:\/|["'])/gu,
    /from\s+["'][^"']*\.(?:test|spec)(?:\.[cm]?[jt]s)?["']/gu,
  ]) {
    if (pattern.test(content)) {
      addFinding("PRODUCTION_TEST_FIXTURE_IMPORT", path, pattern.source);
    }
  }
}

function inspectBundle(path, content) {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  const markers = [
    ["BUNDLE_DATABASE_URL", /postgres(?:ql)?:\/\/[^:@/\s]+:[^@/\s]+@/giu],
    ["BUNDLE_SERVICE_CREDENTIAL", /\bsps_[A-Za-z0-9_-]{16,}\b/gu],
    [
      "BUNDLE_PRIVATE_KEY",
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{100,}\r?\n-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
    ],
    ["BUNDLE_TEST_FIXTURE", /@skillplane\/testing|fixture R2 failure/gu],
    ["BUNDLE_LOCAL_PATH", /\/Users\/[^/\s]+\/|[A-Z]:\\Users\\/gu],
  ];
  for (const [code, pattern] of markers) {
    if (pattern.test(content)) addFinding(code, path, "forbidden marker");
  }
  for (const key of sensitiveEnvironmentKeys) {
    const value = process.env[key];
    if (value && value.length >= 12 && content.includes(value)) {
      addFinding("BUNDLE_CONFIGURED_SECRET", path, key);
    }
  }
  if (
    relativePath.includes("/client/") &&
    /AUTHFN_SECRET|OAUTH_TOKEN_PEPPER|RAILWAY_DATABASE_URL|TURNSTILE_SECRET_KEY/gu.test(
      content,
    )
  ) {
    addFinding("CLIENT_SECRET_NAME", path, "server-only binding marker");
  }
}

for (const sourceRoot of sourceRoots) {
  const absoluteRoot = resolve(root, sourceRoot);
  if (!(await exists(absoluteRoot))) continue;
  for (const path of await walk(absoluteRoot, { ignoreBuildDirectories: true })) {
    if (!textExtensions.has(extname(path))) continue;
    const content = await readFile(path, "utf8").catch(() => "");
    inspectRuntimeSource(path, content);
  }
}

for (const bundleRoot of bundleRoots) {
  const absoluteRoot = resolve(root, bundleRoot);
  if (!(await exists(absoluteRoot))) {
    addFinding("PRODUCTION_BUNDLE_MISSING", absoluteRoot, "run pnpm build first");
    continue;
  }
  for (const path of await walk(absoluteRoot)) {
    const metadata = await stat(path);
    scanned.productionBundleFiles += 1;
    scanned.bundleBytes += metadata.size;
    if (metadata.size > 12 * 1024 * 1024 || !textExtensions.has(extname(path))) {
      continue;
    }
    inspectBundle(path, await readFile(path, "utf8").catch(() => ""));
  }
}

const examplePath = resolve(root, ".env.example");
const example = await readFile(examplePath, "utf8");
for (const key of [
  "AUTHFN_SECRET",
  "CLOUDFLARE_HYPERDRIVE_ID",
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "OAUTH_TOKEN_PEPPER",
  "RAILWAY_DATABASE_URL",
  "TEST_DATABASE_URL",
  "TURNSTILE_SECRET_KEY",
]) {
  const match = example.match(new RegExp(`^${key}=(.*)$`, "mu"));
  if (match?.[1]?.trim()) {
    addFinding("EXAMPLE_CONTAINS_ASSIGNED_SECRET_OR_ID", examplePath, key);
  }
}

for (const path of await walk(root, { ignoreBuildDirectories: true })) {
  if (path.endsWith("package.json")) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    scanned.packageManifests += 1;
    const productionDependencies = manifest.dependencies ?? {};
    if (productionDependencies["@skillplane/testing"]) {
      addFinding("PRODUCTION_TEST_FIXTURE_DEPENDENCY", path, "@skillplane/testing");
    }
    for (const [name, version] of Object.entries({
      ...productionDependencies,
      ...(manifest.optionalDependencies ?? {}),
    })) {
      if (
        typeof version !== "string" ||
        /^(?:file|link):/u.test(version) ||
        version.startsWith("/") ||
        /^git(?:\+|hub:)|^https?:.*\.git(?:#|$)/u.test(version)
      ) {
        addFinding("NON_REPRODUCIBLE_PRODUCTION_DEPENDENCY", path, `${name}`);
      }
    }
  }
}

const clientScan = spawnSync(
  process.execPath,
  [resolve(root, "scripts", "scan-client-secrets.mjs")],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
if (clientScan.status !== 0) {
  addFinding(
    "CLIENT_SECRET_SCAN_FAILED",
    resolve(root, "scripts", "scan-client-secrets.mjs"),
    clientScan.stderr.trim().slice(0, 2_000),
  );
}

const audit = spawnSync(
  "pnpm",
  ["audit", "--prod", "--audit-level", "high", "--json"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
);
let auditSummary;
try {
  const parsed = JSON.parse(audit.stdout || audit.stderr);
  auditSummary = parsed.metadata?.vulnerabilities ?? parsed.metadata ?? {};
} catch {
  auditSummary = { parseError: true };
}
if (audit.status !== 0) {
  addFinding(
    "DEPENDENCY_AUDIT_FAILED",
    resolve(root, "pnpm-lock.yaml"),
    JSON.stringify(auditSummary).slice(0, 2_000),
  );
}

const report = {
  ok: findings.length === 0,
  code:
    findings.length === 0
      ? "PRODUCTION_SECURITY_SCAN_PASSED"
      : "PRODUCTION_SECURITY_SCAN_FAILED",
  scanned,
  dependencyAudit: auditSummary,
  clientBundleScan: clientScan.status === 0,
  findings,
};
if (findings.length > 0) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
