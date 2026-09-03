#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exactStableVersion = /^\d+\.\d+\.\d+$/u;
const browserOnlyPackages = ["@mdfn/svelte", "@mdfn/dom", "@mdfn/source"];
const sharedPackages = ["@mdfn/markdown", "@mdfn/render", "@mdfn/extensions"];

function fail(message) {
  throw new Error(`mdfn adoption verification failed: ${message}`);
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".svelte-kit"].includes(entry.name)) continue;
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile()) files.push(path);
  }
  return files;
}

const uiPackage = JSON.parse(
  await readFile(resolve(repoRoot, "packages/ui/package.json"), "utf8"),
);
const appPackage = JSON.parse(
  await readFile(resolve(repoRoot, "app/package.json"), "utf8"),
);

for (const name of sharedPackages) {
  const version = uiPackage.dependencies?.[name];
  if (typeof version !== "string" || !exactStableVersion.test(version)) {
    fail(`@skillplane/ui must pin ${name} to an exact stable version`);
  }
}

for (const name of [
  "@mdfn/core",
  "@mdfn/extensions",
  "@mdfn/markdown",
  "@mdfn/svelte",
]) {
  const version = appPackage.dependencies?.[name];
  if (typeof version !== "string" || !exactStableVersion.test(version)) {
    fail(`@skillplane/app must pin ${name} to an exact stable version`);
  }
}

if (uiPackage.dependencies?.["@mdfn/svelte"] || uiPackage.dependencies?.["@mdfn/dom"]) {
  fail("@skillplane/ui must not depend on browser mdfn editing packages");
}

const uiSources = await sourceFiles(resolve(repoRoot, "packages/ui/src"));
for (const path of uiSources) {
  if (![".ts", ".svelte", ".js"].includes(extname(path))) continue;
  const content = await readFile(path, "utf8");
  for (const name of browserOnlyPackages) {
    if (content.includes(`from "${name}"`) || content.includes(`from '${name}'`)) {
      fail(
        `${relative(repoRoot, path)} imports ${name}; read-only rendering must stay SSR-safe`,
      );
    }
  }
}

const appSources = await sourceFiles(resolve(repoRoot, "app/src"));
const editorSources = [];
for (const path of appSources) {
  if (![".ts", ".svelte", ".js"].includes(extname(path))) continue;
  const portable = relative(repoRoot, path).replaceAll("\\", "/");
  const content = await readFile(path, "utf8");
  const staticBrowserImport = browserOnlyPackages.some(
    (name) => content.includes(`from "${name}"`) || content.includes(`from '${name}'`),
  );
  if (
    staticBrowserImport &&
    !portable.endsWith("app/src/lib/markdown/load-editor.ts")
  ) {
    fail(`${portable} statically imports browser mdfn editing code`);
  }
  if (
    portable.includes("lib/markdown/") ||
    portable.endsWith("MarkdownEditor.svelte")
  ) {
    editorSources.push(portable);
  }
}

if (!editorSources.includes("app/src/lib/markdown/MarkdownEditor.svelte")) {
  fail("shared MarkdownEditor wrapper is missing");
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      code: "MDFN_ADOPTION_VALID",
      profile: "skillplane.markdown.v1",
      versions: {
        ui: Object.fromEntries(
          sharedPackages.map((name) => [name, uiPackage.dependencies[name]]),
        ),
        app: {
          "@mdfn/core": appPackage.dependencies["@mdfn/core"],
          "@mdfn/extensions": appPackage.dependencies["@mdfn/extensions"],
          "@mdfn/markdown": appPackage.dependencies["@mdfn/markdown"],
          "@mdfn/svelte": appPackage.dependencies["@mdfn/svelte"],
        },
      },
    },
    null,
    2,
  )}\n`,
);
