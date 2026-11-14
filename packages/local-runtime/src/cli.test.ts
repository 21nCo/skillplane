import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const packageRoot = resolve(import.meta.dirname, "..");
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const cli = resolve(packageRoot, "dist/skillplane.mjs");
beforeAll(() => {
  execFileSync(process.execPath, ["build.mjs"], { cwd: packageRoot });
});
describe("packaged global CLI", () => {
  it("installs and completes offline initialization, creation, invocation, export and diagnostics", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-cli-")));
    roots.push(root);
    const project = join(root, "project");
    mkdirSync(project);
    const bin = join(root, "bin");
    execFileSync(process.execPath, [
      resolve(packageRoot, "../../scripts/install-local-client.mjs"),
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
    const repository = join(root, "repository");
    expect(run("export", "--git", repository)).toMatchObject({ files: 4 });
    expect(readFileSync(join(repository, "skills/read/SKILL.md"), "utf8")).toBe(
      "Read the supplied document.",
    );
    run("uninstall", record.id);
    expect(run("doctor").projections).toHaveLength(0);
    const overwrite = spawnSync(process.execPath, [
      resolve(packageRoot, "../../scripts/install-local-client.mjs"),
      bin,
    ]);
    expect(overwrite.status).not.toBe(0);
    // This packaged-CLI flow launches multiple Node processes under concurrent CI.
  }, 30_000);
  it("syncs instruction files across concurrent processes and exits non-zero on a collision", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-cli-instr-")));
    roots.push(root);
    const home = join(root, "home");
    const project = join(root, "project");
    mkdirSync(home);
    mkdirSync(project);
    const env = { ...process.env, HOME: home };
    const args = (...rest: string[]) => [
      cli,
      ...rest,
      "--home",
      join(root, "state"),
      "--project",
      project,
    ];
    const run = (...rest: string[]) =>
      JSON.parse(
        execFileSync(process.execPath, args(...rest), { encoding: "utf8", env }),
      );
    const context = run("init", "Offline");
    const config = join(root, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        ...context,
        instructions: [
          { adapter: "claude", artifact: "global" },
          { adapter: "codex", artifact: "global" },
        ],
      }),
    );
    run("configure", config);
    // Large enough that a non-atomic write would be observable mid-copy.
    const body = `# Global\n\n${"Use the composio CLI when no connector exists.\n".repeat(10_000)}`;
    const request = join(root, "create.json");
    writeFileSync(
      request,
      JSON.stringify({
        kind: "instructions",
        slug: "global",
        name: "Global",
        instructions: body,
        idempotencyKey: "create",
      }),
    );
    run("create", request);

    const claude = join(home, ".claude", "CLAUDE.md");
    mkdirSync(join(home, ".claude"));
    // A reader polls the target for the whole race and counts reads whose
    // bytes are not exactly the published document. Exact reads made before
    // the syncs end are counted apart, so the race itself must be observed.
    const reader = spawn(process.execPath, [
      "-e",
      `const fs=require("node:fs");const {createHash}=require("node:crypto");
         const [file,digest]=process.argv.slice(1);let bad=0,during=0;
         const read=(racing)=>{try{const b=fs.readFileSync(file);
           if(createHash("sha256").update(b).digest("hex")!==digest)bad++;else if(racing)during++;}
           catch(e){if(e.code!=="ENOENT")bad++;}};
         process.stdout.write("ready\\n");
         const stop=Date.now()+15000;
         while(!fs.existsSync(file+".done")&&Date.now()<stop)read(true);
         read(false);process.stdout.write(JSON.stringify({bad,during}));`,
      claude,
      createHash("sha256").update(body).digest("hex"),
    ]);
    let readerOutput = "";
    const readerClosed = new Promise((done) => reader.on("close", done));
    await new Promise<void>((ready) =>
      reader.stdout.on("data", (chunk: Buffer) => {
        readerOutput += chunk.toString();
        if (readerOutput.includes("ready\n")) ready();
      }),
    );
    const syncs = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<{ status: number | null; stdout: string; stderr: string }>(
            (done) => {
              const child = spawn(process.execPath, args("sync"), { env });
              let stdout = "";
              let stderr = "";
              child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
              child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
              child.on("close", (status) => done({ status, stdout, stderr }));
            },
          ),
      ),
    );
    writeFileSync(`${claude}.done`, "");
    await readerClosed;
    const observed = JSON.parse(readerOutput.slice(readerOutput.indexOf("\n") + 1)) as {
      bad: number;
      during: number;
    };
    expect(observed.bad).toBe(0);
    expect(observed.during).toBeGreaterThan(0);
    // Both runs succeed: one writes the file, the other finds that identical
    // result under the projection lock.
    for (const result of syncs) {
      expect(result.stderr).not.toContain('"error"');
      expect(result.status).toBe(0);
    }
    const [first, second] = syncs.map(
      (result) => JSON.parse(result.stdout) as { path: string; eventId: string }[],
    );
    expect(first?.map((row) => row.eventId)).toEqual(second?.map((row) => row.eventId));
    run("sync");
    expect(readFileSync(claude, "utf8")).toBe(body);
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).toBe(body);
    const doctor = run("doctor");
    expect(doctor.instructions.map((row: { state: string }) => row.state)).toEqual([
      "in-sync",
      "in-sync",
    ]);

    // An unmanaged file in a fresh home is refused, byte for byte, with a failing exit.
    const other = join(root, "other-home");
    mkdirSync(join(other, ".codex"), { recursive: true });
    writeFileSync(join(other, ".codex", "AGENTS.md"), "mine\n");
    const refused = spawnSync(process.execPath, args("sync"), {
      encoding: "utf8",
      env: { ...env, HOME: other },
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("projection_collision");
    expect(readFileSync(join(other, ".codex", "AGENTS.md"), "utf8")).toBe("mine\n");
  }, 30_000);
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
