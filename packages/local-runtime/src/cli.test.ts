import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve("dist/skillplane.mjs");
beforeAll(() => {
  execFileSync(process.execPath, ["build.mjs"], { cwd: process.cwd() });
});
describe("packaged global CLI", () => {
  it("installs and completes offline initialization, creation, invocation, export and diagnostics", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-cli-")));
    const project = join(root, "project");
    mkdirSync(project);
    const bin = join(root, "bin");
    execFileSync(process.execPath, [
      resolve("../../scripts/install-local-client.mjs"),
      bin,
    ]);
    const installed = join(bin, "skillplane");
    const run = (...args: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [installed, ...args, "--home", join(root, "state"), "--project", project],
          { encoding: "utf8" },
        ),
      );
    const config = run("init", "Offline", "--target", "codex");
    expect(config.primary.provider).toBe("local");
    const file = join(root, "create.json");
    writeFileSync(
      file,
      JSON.stringify({
        slug: "read",
        name: "Read",
        instructions: "Read the supplied document.",
        idempotencyKey: "create",
      }),
    );
    const created = run("create", file);
    expect(created.skillId).toMatch(/^skill:/);
    const records = run("sync");
    expect(records).toHaveLength(1);
    const record = records[0];
    const resolved = run("resolve", record.id, "--agent", "codex");
    expect(resolved.useEmbedded).toBe(true);
    expect(resolved.instructions).toBeUndefined();
    expect(run("doctor").projections[0].health).toBe("healthy");
    expect(run("usage").uploadEnabled).toBe(false);
    const archive = join(root, "export.zip");
    run("export", created.skillId, archive);
    expect(readFileSync(archive).length).toBeGreaterThan(0);
    run("uninstall", record.id);
    expect(run("doctor").projections).toHaveLength(0);
    const overwrite = spawnSync(process.execPath, [
      resolve("../../scripts/install-local-client.mjs"),
      bin,
    ]);
    expect(overwrite.status).not.toBe(0);
  });
  it("help and validation errors work without service dependencies or secret output", () => {
    expect(
      execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }),
    ).toContain("Skillplane local and cloud");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-invalid-")));
    const result = spawnSync(
      process.execPath,
      [cli, "resolve", "missing", "--home", root],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("projection_not_found");
  });
});
