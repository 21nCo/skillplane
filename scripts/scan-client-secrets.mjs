#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoots = ["app/.svelte-kit/output/client"];
const forbiddenMarkers = [
  "AUTHFN_SECRET",
  "OAUTH_TOKEN_PEPPER",
  "POSTHOG_PROJECT_TOKEN",
  "DATABASE_URL",
  "RAILWAY_DATABASE_URL",
  "TURNSTILE_SECRET_KEY",
  "postgresql://",
  "postgres://",
];
const findings = [];

async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

for (const clientRoot of clientRoots) {
  const absoluteRoot = join(repoRoot, clientRoot);
  try {
    await access(absoluteRoot);
  } catch {
    findings.push({ code: "CLIENT_BUILD_MISSING", path: clientRoot });
    continue;
  }

  for (const path of await walk(absoluteRoot)) {
    if ((await stat(path)).size > 5_000_000) {
      continue;
    }
    const content = await readFile(path, "utf8").catch(() => "");
    for (const marker of forbiddenMarkers) {
      if (content.includes(marker)) {
        findings.push({
          code: "CLIENT_SECRET_MARKER_FOUND",
          path: relative(repoRoot, path).replaceAll("\\", "/"),
          marker,
        });
      }
    }
  }
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
    code: "CLIENT_BUNDLES_SECRET_FREE",
    roots: clientRoots,
  })}\n`,
);
