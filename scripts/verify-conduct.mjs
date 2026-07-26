#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredPaths = [
  ".conduct/ledger.md",
  ".conduct/logs.csv",
  ".conduct/tracker.csv",
  ".conduct/decisions",
  ".conduct/logs/engineering",
  ".conduct/logs/superfunctions",
  ".conduct/observations",
  ".conduct/screenshots/README.md",
  ".conduct/specs/2026-07-25-new-17dd6c3e-spec/logs.csv",
];
const csvHeader = "timestamp,model,launcher,command,agent_name,phase(s),path";

function fail(code, details = undefined) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code,
      ...(details === undefined ? {} : { details }),
    })}\n`,
  );
  process.exit(1);
}

for (const path of requiredPaths) {
  try {
    await access(join(repoRoot, path));
  } catch {
    fail("CONDUCT_STRUCTURE_MISSING", { path });
  }
}

for (const path of [
  ".conduct/logs.csv",
  ".conduct/specs/2026-07-25-new-17dd6c3e-spec/logs.csv",
]) {
  const content = await readFile(join(repoRoot, path), "utf8");
  const lines = content.trimEnd().split("\n");
  if (lines[0] !== csvHeader || lines.some((line) => line.trim() === "")) {
    fail("CONDUCT_LOG_INVALID", { path });
  }

  for (const line of lines.slice(1)) {
    const columns = line.split(",");
    if (columns.length !== 7) {
      fail("CONDUCT_LOG_INVALID", { path });
    }
    const reportPath = columns[6];
    if (
      columns[3] === "execute" &&
      !(await access(join(repoRoot, reportPath)).then(
        () => true,
        () => false,
      ))
    ) {
      fail("CONDUCT_REPORT_MISSING", { path: reportPath });
    }
  }
}

function readHead(path) {
  try {
    return execFileSync("git", ["show", `HEAD:${path}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

for (const path of [
  ".conduct/ledger.md",
  ".conduct/logs.csv",
  ".conduct/specs/2026-07-25-new-17dd6c3e-spec/logs.csv",
]) {
  const previous = readHead(path);
  if (previous !== null) {
    const current = await readFile(join(repoRoot, path), "utf8");
    if (!current.startsWith(previous)) {
      fail("CONDUCT_APPEND_ONLY_VIOLATION", { path });
    }
  }
}

try {
  execFileSync("node", ["scripts/preflight.mjs", "--check-portability"], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "pipe"],
  });
} catch {
  fail("CONDUCT_PORTABILITY_VIOLATION");
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    code: "CONDUCT_VALID",
    appendOnlyBaseline: readHead(".conduct/logs.csv") !== null,
  })}\n`,
);
