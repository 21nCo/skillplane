#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const roots = ["app/src", "packages/ui/src"];
const allowedColorFile = "packages/ui/src/styles/tokens.css";
const sourceExtensions = new Set([".css", ".svelte", ".ts"]);
const rawColorPattern =
  /(?:^|[\s:(,])(?:#[\da-f]{3}(?:[\da-f]{3})?(?:[\da-f]{2})?|(?:rgb|hsl|oklch|lab|lch)\()/giu;
const disallowedIconImportPattern =
  /from\s+["'](?:lucide[^"']*|@heroicons[^"']*|react-icons[^"']*|@tabler\/icons[^"']*)["']/gu;
const rawNamedColorPattern =
  /(?:^|[;{\s])(?:color|background|background-color|border-color):\s*(?:white|black)\b/giu;

async function walk(path) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(child)));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name)))
      output.push(child);
  }
  return output;
}

function lineFor(content, index) {
  return content.slice(0, index).split("\n").length;
}

function inspectContent(path, content, allowColors = false) {
  const findings = [];
  if (!allowColors) {
    for (const match of content.matchAll(rawColorPattern)) {
      findings.push({
        code: "RAW_FEATURE_COLOR",
        path,
        line: lineFor(content, match.index ?? 0),
        value: match[0].trim(),
      });
    }
    for (const match of content.matchAll(rawNamedColorPattern)) {
      findings.push({
        code: "RAW_FEATURE_COLOR",
        path,
        line: lineFor(content, match.index ?? 0),
        value: match[0].trim(),
      });
    }
  }
  for (const match of content.matchAll(disallowedIconImportPattern)) {
    findings.push({
      code: "UNAPPROVED_ICON_IMPORT",
      path,
      line: lineFor(content, match.index ?? 0),
      value: match[0],
    });
  }
  return findings;
}

function selfTest() {
  const color = inspectContent("fixture.svelte", "<style>p { color: #fff; }</style>");
  const icon = inspectContent("fixture.ts", 'import { Search } from "lucide-svelte";');
  const approved = inspectContent(
    "fixture.svelte",
    '<script>import { SearchIcon } from "phosphor-svelte";</script><p class="text-content">',
  );
  if (
    color[0]?.code !== "RAW_FEATURE_COLOR" ||
    icon[0]?.code !== "UNAPPROVED_ICON_IMPORT" ||
    approved.length !== 0
  ) {
    throw new Error("DESIGN_SYSTEM_LINTER_SELF_TEST_FAILED");
  }
}

if (process.argv.includes("--self-test")) selfTest();

const findings = [];
for (const root of roots) {
  for (const absolutePath of await walk(join(repoRoot, root))) {
    const path = relative(repoRoot, absolutePath).replaceAll("\\", "/");
    const content = await readFile(absolutePath, "utf8");
    findings.push(...inspectContent(path, content, path === allowedColorFile));
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `${JSON.stringify(
      {
        ok: false,
        code: "DESIGN_SYSTEM_POLICY_VIOLATION",
        findings,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    code: "DESIGN_SYSTEM_POLICY_PASSED",
    roots,
    colorSource: allowedColorFile,
    iconLibrary: "phosphor-svelte",
  })}\n`,
);
