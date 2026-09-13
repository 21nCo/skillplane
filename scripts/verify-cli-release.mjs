#!/usr/bin/env node

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import crossSpawn from "cross-spawn";

const root = resolve(import.meta.dirname, "..");

/** Run one release verification command and surface its captured failure output. */
function run(command, args, options = {}) {
  const result = crossSpawn.sync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(output || `${command} ${args.join(" ")} failed`);
  }
  return result.stdout?.trim() ?? "";
}

const temporary = await mkdtemp(join(tmpdir(), "skillplane-cli-release-"));
try {
  run("pnpm", ["--filter", "skillplane", "typecheck"]);
  run("pnpm", ["--filter", "skillplane", "test:unit"]);
  run("pnpm", ["--filter", "skillplane", "build"]);
  run("pnpm", ["--filter", "skillplane", "pack", "--pack-destination", temporary]);

  const archives = (await readdir(temporary)).filter((file) => file.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`Expected one CLI tarball, found ${archives.length}`);
  }
  const consumer = join(temporary, "consumer");
  run("npm", [
    "install",
    "--prefix",
    consumer,
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(temporary, archives[0]),
  ]);
  const executable = join(
    consumer,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "skillplane.cmd" : "skillplane",
  );
  const help = run(executable, ["--help"], {
    capture: true,
    env: {
      ...process.env,
      PATH: `${join(consumer, "node_modules", ".bin")}${delimiter}${process.env.PATH}`,
    },
  });
  if (!help.includes("Skillplane local and cloud workspaces")) {
    throw new Error("Installed CLI did not return the expected help output");
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, package: "skillplane", archive: archives[0] })}\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
