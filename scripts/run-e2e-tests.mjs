#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forwarded = process.argv.slice(2);
const explicitSpecs = forwarded.filter((argument) => argument.endsWith(".spec.ts"));

const reset = spawnSync("pnpm", ["--filter", "@skillplane/testing", "db:reset:test"], {
  cwd: root,
  encoding: "utf8",
  stdio: "inherit",
});
if (reset.status !== 0) process.exit(reset.status ?? 1);

function run(specifications, extraArguments) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "packages/testing/playwright.config.ts",
      "--pass-with-no-tests",
      ...specifications,
      ...extraArguments,
    ],
    {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=development"]
          .filter(Boolean)
          .join(" "),
      },
    },
  );
  return result.status ?? 1;
}

if (explicitSpecs.length > 0) {
  const argumentsWithoutSpecs = forwarded.filter(
    (argument) => !explicitSpecs.includes(argument),
  );
  process.exit(run(explicitSpecs, argumentsWithoutSpecs));
}

const files = readdirSync(resolve(root, "packages", "testing", "e2e"))
  .filter((name) => name.endsWith(".spec.ts"))
  .sort();
const visual = files.filter((name) => name.includes(".visual."));
const nonVisual = files.filter((name) => !name.includes(".visual."));
const landing = nonVisual.filter((name) => name.startsWith("landing."));
const application = nonVisual.filter((name) => !name.startsWith("landing."));
const applicationVisual = visual
  .filter((name) => !name.startsWith("landing."))
  .map((name) => [name]);
const landingVisual = visual
  .filter((name) => name.startsWith("landing."))
  .map((name) => [name]);

// App and landing harnesses both embed SvelteKit through Vite. Keep them in
// separate worker processes so Vite's process-level SSR/config module cache
// cannot resolve one project's lazy route modules through the other's root.
// Visual suites also run one file per process so rasterization is not affected
// by fonts, icons, and browser state loaded by preceding functional suites.
for (const group of [application, ...applicationVisual, landing, ...landingVisual]) {
  if (group.length === 0) continue;
  const status = run(group, forwarded);
  if (status !== 0) process.exit(status);
}
