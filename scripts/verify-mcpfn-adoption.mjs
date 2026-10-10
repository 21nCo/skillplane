#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(`McpFn adoption verification failed: ${message}`);
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
const exactStableVersion = /^\d+\.\d+\.\d+$/u;
const selectedVersions = new Map();
for (const { label, packageJsonPath, required } of consumers) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  for (const [section, names] of Object.entries(required)) {
    const opposite = section === "dependencies" ? "devDependencies" : "dependencies";
    for (const name of names) {
      if (Object.hasOwn(packageJson[opposite] ?? {}, name)) {
        fail(`${label} must declare ${name} only in ${section}`);
      }
      const version = packageJson[section]?.[name];
      if (typeof version !== "string" || !exactStableVersion.test(version)) {
        fail(
          `${label} must consume ${name} from ${section} at an exact stable version`,
        );
      }
      const selected = selectedVersions.get(name);
      if (selected && selected !== version) {
        fail(`${name} versions disagree across consumers: ${selected} and ${version}`);
      }
      selectedVersions.set(name, version);
    }
  }
}

function resolveLocalModule(fromPath, specifier, availableFiles) {
  const target = resolve(dirname(fromPath), specifier);
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    `${target}.mts`,
    `${target}.cts`,
    ...[".ts", ".tsx", ".mts", ".cts"].map((extension) =>
      target.replace(/\.[cm]?js$/u, extension),
    ),
    resolve(target, "index.ts"),
    resolve(target, "index.tsx"),
    resolve(target, "index.mts"),
    resolve(target, "index.cts"),
  ];
  return candidates.find((candidate) => availableFiles.has(candidate));
}

function moduleSpecifiers(parsed) {
  const specifiers = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
        fail("MCP source graph contains a non-literal dynamic import");
      }
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return specifiers;
}

function isSourceModuleSpecifier(specifier) {
  const extension = extname(specifier);
  return (
    extension === "" ||
    [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"].includes(extension)
  );
}

async function reachableMcpSources() {
  const sourceRoot = resolve(repoRoot, "mcp/src");
  const availableFiles = new Set(
    (await sourceFiles(sourceRoot)).filter(
      (path) =>
        /\.(?:[cm]?ts|tsx)$/u.test(path) &&
        !path.endsWith(".test.ts") &&
        !path.endsWith(".d.ts"),
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
    for (const specifier of moduleSpecifiers(parsed)) {
      if (!specifier.startsWith(".")) continue;
      const dependency = resolveLocalModule(path, specifier, availableFiles);
      if (dependency) {
        pending.push(dependency);
      } else if (isSourceModuleSpecifier(specifier)) {
        fail(`${relative(repoRoot, path)} cannot resolve local module ${specifier}`);
      }
    }
  }
  return reachable;
}

function namedImportBinding(parsed, moduleName, importedName) {
  const bindings = [];
  for (const statement of parsed.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if ((element.propertyName?.text ?? element.name.text) === importedName) {
        bindings.push(element.name.text);
      }
    }
  }
  if (bindings.length !== 1) {
    fail(`expected one ${moduleName}:${importedName} named import`);
  }
  return bindings[0];
}

function assertNoDirectSdkServerImports(sources) {
  for (const parsed of sources.values()) {
    for (const moduleName of moduleSpecifiers(parsed)) {
      if (moduleName.startsWith("@modelcontextprotocol/sdk/server/")) {
        fail("Skillplane still imports an SDK server or transport directly");
      }
    }
  }
}

function isFunctionExpression(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function walkExecutable(root, visitor) {
  const visit = (node) => {
    if (node !== root && ts.isFunctionLike(node)) return;
    visitor(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function initializedVariables(root, predicate) {
  const variables = [];
  walkExecutable(root, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) return;
    const initializer = node.initializer && unwrapExpression(node.initializer);
    if (!initializer || !ts.isCallExpression(initializer) || !predicate(initializer)) {
      return;
    }
    variables.push({ name: node.name.text, call: initializer });
  });
  return variables;
}

function directCalls(root, predicate) {
  const calls = [];
  walkExecutable(root, (node) => {
    if (ts.isCallExpression(node) && predicate(node)) calls.push(node);
  });
  return calls;
}

function identifierCall(call, name) {
  return ts.isIdentifier(call.expression) && call.expression.text === name;
}

function propertyCall(call, receiver, method) {
  return (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === receiver &&
    call.expression.name.text === method
  );
}

function mcpRouteCallbacks(entry) {
  const callbacks = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "all" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "/mcp" &&
      isFunctionExpression(node.arguments[1])
    ) {
      callbacks.push(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(entry);
  return callbacks;
}

function assertProductionEntrypoint(entry) {
  const authBinding = namedImportBinding(
    entry,
    "@mcpfn/auth",
    "createAuthProviderMcpHandler",
  );
  const serverFactoryBinding = namedImportBinding(
    entry,
    "./server.js",
    "createSkillplaneMcpServer",
  );
  const routeCallbacks = mcpRouteCallbacks(entry);
  if (routeCallbacks.length !== 1) fail("expected one production /mcp route");
  const route = routeCallbacks[0];
  const handlers = initializedVariables(route, (call) =>
    identifierCall(call, authBinding),
  );
  if (handlers.length !== 1) {
    fail("the production /mcp route does not create exactly one McpFn auth handler");
  }
  const transport = handlers[0].call.arguments[0];
  if (!transport || !isFunctionExpression(transport)) {
    fail("the production McpFn auth handler does not wrap a transport callback");
  }
  const servers = initializedVariables(transport, (call) =>
    identifierCall(call, serverFactoryBinding),
  );
  if (servers.length !== 1) {
    fail(
      "the production transport callback does not create the Skillplane McpFn server",
    );
  }
  const protocolHandlers = initializedVariables(transport, (call) =>
    propertyCall(call, servers[0].name, "createWebStandardHandler"),
  );
  if (protocolHandlers.length !== 1) {
    fail("the production McpFn server does not create its web-standard handler");
  }
  if (
    !directCalls(transport, (call) => identifierCall(call, protocolHandlers[0].name))
      .length
  ) {
    fail("the production transport callback does not invoke the web-standard handler");
  }
  if (!directCalls(route, (call) => identifierCall(call, handlers[0].name)).length) {
    fail("the production /mcp route does not invoke the McpFn auth handler");
  }
}

function hasExportModifier(node) {
  return (
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
  );
}

function assertServerFactory(serverModule) {
  const defineBinding = namedImportBinding(
    serverModule,
    "@mcpfn/core",
    "defineMcpFnServer",
  );
  const declarationName = "skillplaneMcpDeclaration";
  const declaration = serverModule.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      hasExportModifier(statement) &&
      statement.declarationList.declarations.some((entry) => {
        const initializer = entry.initializer && unwrapExpression(entry.initializer);
        return (
          ts.isIdentifier(entry.name) &&
          entry.name.text === declarationName &&
          initializer &&
          ts.isCallExpression(initializer) &&
          identifierCall(initializer, defineBinding)
        );
      }),
  );
  if (!declaration) fail("the exported Skillplane declaration does not call McpFn");
  const factory = serverModule.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "createSkillplaneMcpServer" &&
      hasExportModifier(statement),
  );
  if (!factory || !factory.body)
    fail("the exported Skillplane McpFn factory is missing");
  const returnsServer = directCalls(factory, (call) =>
    propertyCall(call, declarationName, "createServer"),
  ).some((call) => ts.isReturnStatement(call.parent));
  if (!returnsServer) {
    fail("the Skillplane McpFn factory does not return a server from its declaration");
  }
}

const mcpSources = await reachableMcpSources();
assertNoDirectSdkServerImports(mcpSources);
assertProductionEntrypoint(mcpSources.get(resolve(repoRoot, "mcp/src/index.ts")));
assertServerFactory(mcpSources.get(resolve(repoRoot, "mcp/src/server.ts")));

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

const selection = [...selectedVersions]
  .map(([name, version]) => `${name}@${version}`)
  .join(", ");
process.stdout.write(`McpFn adoption verified with ${selection}.\n`);
