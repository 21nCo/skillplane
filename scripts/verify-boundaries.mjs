#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredWorkspaces = ["app", "landing", "mcp", "packages"];
const productionRoots = ["app/src", "landing/src", "mcp/src", "packages"];
const findings = [];

async function exists(path) {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function walk(root) {
  if (!(await exists(root))) {
    return [];
  }
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      [".svelte-kit", "dist", "node_modules"].includes(entry.name)
    ) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

for (const workspace of requiredWorkspaces) {
  if (!(await exists(join(repoRoot, workspace)))) {
    findings.push({ code: "WORKSPACE_MISSING", path: workspace });
  }
}

for (const forbiddenPath of [
  "app/src/lib/domain",
  "landing/src/lib/domain",
  "mcp/src/domain",
]) {
  if (await exists(join(repoRoot, forbiddenPath))) {
    findings.push({
      code: "WORKSPACE_BOUNDARY_VIOLATION",
      path: forbiddenPath,
    });
  }
}

const appServerRoutes = (await walk(join(repoRoot, "app", "src", "routes")))
  .filter((path) => path.endsWith("+server.ts"))
  .map((path) => relative(repoRoot, path).replaceAll("\\", "/"));
for (const route of appServerRoutes) {
  if (route !== "app/src/routes/api/[...path]/+server.ts") {
    findings.push({ code: "DUPLICATE_API_COMPOSITION", path: route });
  }
}

for (const root of productionRoots) {
  for (const path of await walk(join(repoRoot, root))) {
    if (![".ts", ".svelte", ".js", ".mjs"].includes(extname(path))) {
      continue;
    }
    const portablePath = relative(repoRoot, path).replaceAll("\\", "/");
    if (
      portablePath.includes(".test.") ||
      portablePath.startsWith("packages/testing/")
    ) {
      continue;
    }
    const content = await readFile(path, "utf8");
    if (content.includes("@skillplane/testing")) {
      findings.push({
        code: "TEST_FIXTURE_IN_PRODUCTION_GRAPH",
        path: portablePath,
      });
    }
    for (const term of ["TO" + "DO", "T" + "BD", "FIX" + "ME"]) {
      if (content.includes(term)) {
        findings.push({
          code: "DEFERRED_PRODUCTION_IMPLEMENTATION",
          path: portablePath,
        });
      }
    }
  }
}

const appRoute = await readFile(
  join(repoRoot, "app/src/routes/api/[...path]/+server.ts"),
  "utf8",
).catch(() => "");
const appComposition = await readFile(
  join(repoRoot, "app/src/lib/server/api.ts"),
  "utf8",
).catch(() => "");
if (
  !appRoute.includes("$lib/server/api") ||
  !appComposition.includes("@skillplane/api")
) {
  findings.push({
    code: "DUPLICATE_API_COMPOSITION",
    path: "app/src/routes/api/[...path]/+server.ts",
  });
}

const mcpEntry = await readFile(join(repoRoot, "mcp/src/index.ts"), "utf8").catch(
  () => "",
);
if (!mcpEntry.includes("@skillplane/api")) {
  findings.push({
    code: "WORKSPACE_BOUNDARY_VIOLATION",
    path: "mcp/src/index.ts",
  });
}

if (findings.length > 0) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, code: findings[0].code, findings }, null, 2)}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    code: "WORKSPACE_BOUNDARIES_VALID",
    workspaces: requiredWorkspaces,
    appServerRoutes,
  })}\n`,
);
