#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exactStableVersion = /^\d+\.\d+\.\d+$/u;
const browserOnlyPackages = ["@mdfn/svelte", "@mdfn/dom", "@mdfn/source"];
const sharedPackages = ["@mdfn/markdown", "@mdfn/render", "@mdfn/extensions"];
const approvedEditorLoader = "app/src/lib/markdown/load-editor.ts";
const requiredSurfaces = {
  "app/src/routes/(app)/[workspaceSlug]/skills/new/+page.svelte": "skill-create",
  "app/src/lib/skills/SkillEditor.svelte": "skill-amend",
  "app/src/lib/contexts/ContextEditor.svelte": "context-create",
  "app/src/lib/contexts/KnowledgeEditor.svelte": "knowledge-revise",
  "app/src/lib/contexts/NoteEditor.svelte": "note",
};

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

function moduleSpecifiers(content) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bexport\s+\*\s+from\s*["']([^"']+)["']/gu,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
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

for (const name of browserOnlyPackages) {
  if (uiPackage.dependencies?.[name] || uiPackage.devDependencies?.[name]) {
    fail(`@skillplane/ui must not depend on ${name}`);
  }
}

const uiSources = await sourceFiles(resolve(repoRoot, "packages/ui/src"));
for (const path of uiSources) {
  if (![".ts", ".svelte", ".js"].includes(extname(path))) continue;
  const content = await readFile(path, "utf8");
  for (const specifier of moduleSpecifiers(content)) {
    if (browserOnlyPackages.includes(specifier)) {
      fail(
        `${relative(repoRoot, path)} imports ${specifier}; read-only rendering must stay SSR-safe`,
      );
    }
  }
}

const appSources = await sourceFiles(resolve(repoRoot, "app/src"));
let editorWrapper = false;
for (const path of appSources) {
  if (![".ts", ".svelte", ".js"].includes(extname(path))) continue;
  const portable = relative(repoRoot, path).replaceAll("\\", "/");
  const content = await readFile(path, "utf8");
  const browserImports = moduleSpecifiers(content).filter((specifier) =>
    browserOnlyPackages.includes(specifier),
  );
  if (browserImports.length > 0 && portable !== approvedEditorLoader) {
    fail(
      `${portable} imports ${browserImports.join(", ")}; browser mdfn editing packages may load only from ${approvedEditorLoader}`,
    );
  }
  if (portable.endsWith("app/src/lib/markdown/MarkdownEditor.svelte")) {
    editorWrapper = true;
  }
}

if (!editorWrapper) fail("shared MarkdownEditor wrapper is missing");

for (const [portable, surface] of Object.entries(requiredSurfaces)) {
  const content = await readFile(resolve(repoRoot, portable), "utf8");
  if (!content.includes('from "$lib/markdown/MarkdownEditor.svelte"')) {
    fail(`${portable} must import the shared MarkdownEditor wrapper`);
  }
  if (
    !content.includes(`surface="${surface}"`) &&
    !content.includes(`surface={'${surface}'}`) &&
    !content.includes(`surface={"${surface}"}`)
  ) {
    fail(`${portable} must bind MarkdownEditor surface="${surface}"`);
  }
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
