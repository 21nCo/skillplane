#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gitExecutable =
  process.platform === "win32"
    ? "C:\\Program Files\\Git\\cmd\\git.exe"
    : "/usr/bin/git";
const contract = JSON.parse(
  await readFile(resolve(repoRoot, "mcpfn-source.json"), "utf8"),
);
const sourceRoot = resolve(repoRoot, contract.sourceRoot);

function fail(message) {
  throw new Error(`McpFn adoption verification failed: ${message}`);
}

const head = execFileSync(gitExecutable, ["-C", sourceRoot, "rev-parse", "HEAD"], {
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

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

const digest = createHash("sha256");
for (const [name, packageContract] of Object.entries(contract.packages).toSorted(
  ([left], [right]) => compareCodeUnits(left, right),
)) {
  const packageRoot = resolve(sourceRoot, packageContract.path);
  const packageJsonPath = resolve(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (packageJson.name !== name || packageJson.version !== packageContract.version) {
    fail(`${name} package identity does not match mcpfn-source.json`);
  }
  const files = [
    packageJsonPath,
    ...(await sourceFiles(resolve(packageRoot, "src"))),
    ...(await sourceFiles(resolve(packageRoot, "dist"))),
  ].toSorted(compareCodeUnits);
  for (const path of files) {
    const content = await readFile(path);
    const label = relative(sourceRoot, path).replaceAll("\\", "/");
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
  {
    label: "mcp",
    packageJsonPath: resolve(repoRoot, "mcp", "package.json"),
    required: {
      dependencies: ["@mcpfn/auth", "@mcpfn/core"],
      devDependencies: ["@mcpfn/testing"],
    },
  },
  {
    label: "oauth",
    packageJsonPath: resolve(repoRoot, "packages", "authfn-mcp-oauth", "package.json"),
    required: { dependencies: ["@mcpfn/auth"], devDependencies: [] },
  },
];
for (const { label, packageJsonPath, required } of consumers) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  for (const [section, names] of Object.entries(required)) {
    const opposite = section === "dependencies" ? "devDependencies" : "dependencies";
    for (const name of names) {
      if (Object.hasOwn(packageJson[opposite] ?? {}, name)) {
        fail(`${label} must declare ${name} only in ${section}`);
      }
      const link = packageJson[section]?.[name];
      if (typeof link !== "string" || !link.startsWith("link:")) {
        fail(
          `${label} must consume ${name} from ${section} through an explicit local link`,
        );
      }
      const resolved = resolve(dirname(packageJsonPath), link.slice("link:".length));
      const expected = resolve(sourceRoot, contract.packages[name].path);
      if (resolved !== expected) {
        fail(`${label} ${name} link resolves outside the pinned worktree`);
      }
    }
  }
}

function resolveLocalModule(fromPath, specifier, availableFiles) {
  const target = resolve(dirname(fromPath), specifier);
  const candidates = [
    target,
    target.replace(/\.[cm]?js$/u, ".ts"),
    resolve(target, "index.ts"),
  ];
  return candidates.find((candidate) => availableFiles.has(candidate));
}

async function reachableMcpSources() {
  const sourceRoot = resolve(repoRoot, "mcp/src");
  const availableFiles = new Set(
    (await sourceFiles(sourceRoot)).filter(
      (path) =>
        path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"),
    ),
  );
  const entry = resolve(sourceRoot, "index.ts");
  const pending = [entry];
  const reachable = new Map();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || reachable.has(path)) continue;
    const contents = await readFile(path, "utf8");
    const parsed = ts.createSourceFile(
      path,
      contents,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    reachable.set(path, parsed);
    for (const statement of parsed.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith(".")
      ) {
        const dependency = resolveLocalModule(
          path,
          statement.moduleSpecifier.text,
          availableFiles,
        );
        if (dependency) pending.push(dependency);
      }
    }
  }
  return reachable;
}

function inspectMcpModuleGraph(sources) {
  const calledImports = new Set();
  let createsWebStandardHandler = false;
  for (const parsed of sources.values()) {
    const imports = new Map();
    for (const statement of parsed.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const moduleName = statement.moduleSpecifier.text;
      if (
        moduleName.includes("@modelcontextprotocol/sdk/server/mcp") ||
        moduleName.includes("WebStandardStreamableHTTPServerTransport")
      ) {
        fail("Skillplane still imports an SDK server or transport directly");
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "WebStandardStreamableHTTPServerTransport") {
          fail("Skillplane still imports an SDK server or transport directly");
        }
        imports.set(element.name.text, {
          imported: importedName,
          moduleName,
        });
      }
    }
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        if (ts.isIdentifier(node.expression)) {
          const imported = imports.get(node.expression.text);
          if (imported) {
            calledImports.add(`${imported.moduleName}:${imported.imported}`);
          }
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "createWebStandardHandler"
        ) {
          createsWebStandardHandler = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  if (!calledImports.has("@mcpfn/core:defineMcpFnServer")) {
    fail("MCP declaration does not call McpFn");
  }
  if (!calledImports.has("@mcpfn/auth:createAuthProviderMcpHandler")) {
    fail("MCP auth does not call the provider-shaped McpFn handler");
  }
  if (!createsWebStandardHandler) {
    fail("MCP transport does not call the McpFn web-standard handler");
  }
}

inspectMcpModuleGraph(await reachableMcpSources());

const oauthPlugin = await readFile(
  resolve(repoRoot, "packages/authfn-mcp-oauth/src/plugin.ts"),
  "utf8",
);
const oauthClients = await readFile(
  resolve(repoRoot, "packages/authfn-mcp-oauth/src/clients.ts"),
  "utf8",
);
if (/path:\s*["']\/oauth\/register\/:|method:\s*["']DELETE["']/u.test(oauthPlugin)) {
  fail("legacy dynamic-registration management routes remain enabled");
}
if (/\.fetcher\s*\(/u.test(oauthClients)) {
  fail("Skillplane still hydrates Client ID Metadata Documents itself");
}

process.stdout.write(`McpFn adoption verified at ${head} (${actualDigest}).\n`);
