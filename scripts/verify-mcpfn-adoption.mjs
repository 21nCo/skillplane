#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(
  await readFile(resolve(repoRoot, "mcpfn-source.json"), "utf8"),
);
const sourceRoot = resolve(repoRoot, contract.sourceRoot);

function fail(message) {
  throw new Error(`McpFn adoption verification failed: ${message}`);
}

const head = execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== contract.baseCommit) {
  fail(`expected base commit ${contract.baseCommit}, received ${head}`);
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const digest = createHash("sha256");
for (const [name, packageContract] of Object.entries(contract.packages).sort()) {
  const packageRoot = resolve(sourceRoot, packageContract.path);
  const packageJsonPath = resolve(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.name !== name || packageJson.version !== packageContract.version) {
    fail(`${name} package identity does not match mcpfn-source.json`);
  }
  const files = [packageJsonPath, ...(await sourceFiles(resolve(packageRoot, "src")))];
  for (const path of files.sort()) {
    const content = await readFile(path);
    const label = relative(sourceRoot, path);
    digest.update(label).update("\0").update(String(content.byteLength)).update("\0");
    digest.update(content);
  }
}
const actualDigest = `sha256:${digest.digest("hex")}`;
if (process.argv.includes("--print-digest")) {
  process.stdout.write(`${actualDigest}\n`);
  process.exit(0);
}
if (actualDigest !== contract.sourceDigest) {
  fail(`expected source digest ${contract.sourceDigest}, received ${actualDigest}`);
}

const consumers = [
  [
    "mcp",
    resolve(repoRoot, "mcp", "package.json"),
    ["@mcpfn/auth", "@mcpfn/core", "@mcpfn/testing"],
  ],
  [
    "oauth",
    resolve(repoRoot, "packages", "authfn-mcp-oauth", "package.json"),
    ["@mcpfn/auth"],
  ],
];
for (const [label, packageJsonPath, names] of consumers) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  for (const name of names) {
    const link = dependencies[name];
    if (typeof link !== "string" || !link.startsWith("link:")) {
      fail(`${label} must consume ${name} through an explicit local link`);
    }
    const resolved = resolve(dirname(packageJsonPath), link.slice("link:".length));
    const expected = resolve(sourceRoot, contract.packages[name].path);
    if (resolved !== expected)
      fail(`${label} ${name} link resolves outside the pinned worktree`);
  }
}

const mcpServer = await readFile(resolve(repoRoot, "mcp/src/server.ts"), "utf8");
const mcpWorker = await readFile(resolve(repoRoot, "mcp/src/index.ts"), "utf8");
const oauthPlugin = await readFile(
  resolve(repoRoot, "packages/authfn-mcp-oauth/src/plugin.ts"),
  "utf8",
);
const oauthClients = await readFile(
  resolve(repoRoot, "packages/authfn-mcp-oauth/src/clients.ts"),
  "utf8",
);
if (!mcpServer.includes("defineMcpFnServer"))
  fail("MCP declaration does not use McpFn");
if (!mcpWorker.includes("createAuthProviderMcpHandler"))
  fail("MCP auth is not provider-shaped");
if (!mcpWorker.includes("createWebStandardHandler"))
  fail("MCP transport is not McpFn-owned");
if (
  /WebStandardStreamableHTTPServerTransport|sdk\/server\/mcp/u.test(
    mcpWorker + mcpServer,
  )
) {
  fail("Skillplane still constructs an SDK server or transport directly");
}
if (/path:\s*["']\/oauth\/register\/:|method:\s*["']DELETE["']/u.test(oauthPlugin)) {
  fail("legacy dynamic-registration management routes remain enabled");
}
if (/\.fetcher\s*\(/u.test(oauthClients)) {
  fail("Skillplane still hydrates Client ID Metadata Documents itself");
}

process.stdout.write(`McpFn adoption verified at ${head} (${actualDigest}).\n`);
