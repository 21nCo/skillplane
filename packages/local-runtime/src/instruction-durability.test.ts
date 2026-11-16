import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every fsync, rename and removal, in order, so a test can prove what was
// durable before a commit, a replacement or a deletion.
const events: string[] = [];
const descriptors = new Map<number, string>();
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  return {
    ...real,
    default: real,
    openSync: (...args: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...args);
      descriptors.set(fd, String(args[0]));
      return fd;
    },
    fsyncSync: (fd: number) => {
      events.push(`fsync ${descriptors.get(fd) ?? fd}`);
      real.fsyncSync(fd);
    },
    renameSync: (from: string, to: string) => {
      events.push(`rename ${to}`);
      real.renameSync(from, to);
    },
    unlinkSync: (path: string) => {
      events.push(`unlink ${path}`);
      real.unlinkSync(path);
    },
    rmSync: (path: string, options?: Parameters<typeof real.rmSync>[1]) => {
      events.push(`rm ${path}`);
      real.rmSync(path, options);
    },
  };
});
const {
  InstructionProjections,
  LocalStore,
  LocalWorkspaceProvider,
  Projections,
  Runtime,
  requireValue,
} = await import("./index.js");

const sha = (bytes: string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const original = "# My agents file\n\nAlways run the tests.\n";
const v2 = "# Global agents\n\nPrefer small commits.\n";
const roots: { root: string; store: InstanceType<typeof LocalStore> }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const { root, store } of roots.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-durable-")));
  const home = join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  const store = new LocalStore(join(home, ".skillplane"));
  roots.push({ root, store });
  const runtime = new Runtime(store);
  const project = join(root, "project");
  mkdirSync(project);
  const context = runtime.setup(project, "Personal");
  runtime.configure(project, {
    ...context,
    instructions: [{ adapter: "claude", artifact: "global-agents" }],
  });
  const provider = new LocalWorkspaceProvider(store, context.primary.id);
  const claude = join(home, ".claude", "CLAUDE.md");
  mkdirSync(dirname(claude));
  writeFileSync(claude, original);
  chmodSync(claude, 0o640);
  const id = InstructionProjections.id(claude);
  const projections = join(dirname(claude), ".skillplane-projections");
  const backup = join(projections, "instructions", id, "backup");
  // The backup directory chain, from the target's directory down.
  const chain = [
    dirname(claude),
    projections,
    join(projections, "instructions"),
    join(projections, "instructions", id),
    backup,
  ];
  return { store, runtime, project, provider, claude, id, backup, chain };
}
type Fixture = ReturnType<typeof fixture>;

async function approve(f: Fixture, skillId: string, versionId: string) {
  const rows = (await f.provider.candidates(skillId)) as {
    reviewId: string;
    expectedUpdatedAt: string;
  }[];
  const row = requireValue(rows.find((r) => r.reviewId === versionId));
  await f.provider.decide(
    skillId,
    versionId,
    row.expectedUpdatedAt,
    true,
    "Ok",
    randomUUID(),
  );
}
async function publish(f: Fixture, skillId: string, text: string) {
  const current = await f.provider.retrieve(skillId);
  const amended = await f.provider.amend({
    skillId,
    baseVersionId: current.version.id,
    proposedBump: "minor",
    idempotencyKey: randomUUID(),
    changes: [
      {
        operation: "replace",
        path: "AGENTS.md",
        expectedSha256: sha(original).slice(7),
        content: text,
      },
    ],
    learning: {
      summary: "Update",
      observation: "Update",
      rationale: "Update",
      confidence: "high",
      evidence: [],
      evidenceUnavailableReason: "Editorial",
      validation: [],
      validationNotRunReason: "Editorial",
      sourceContextId: null,
      tags: [],
      externalReferences: [],
      extra: {},
    },
  });
  await approve(f, skillId, amended.versionId);
}
/** Adopts, publishes and syncs, then syncs v2 so the record is not the original. */
async function managedAtV2(f: Fixture) {
  const adopted = await f.runtime.adoptInstructions(f.project, f.claude);
  const draft = requireValue(adopted.draft);
  await approve(f, draft.skill.id, draft.versionId);
  await f.runtime.sync(f.project);
  await publish(f, draft.skill.id, v2);
  await f.runtime.sync(f.project);
}
/** Asserts each event occurred, in this order. */
function ordered(...expected: string[]): void {
  let from = 0;
  for (const event of expected) {
    const at = events.indexOf(event, from);
    expect(
      at,
      `${event} after ${expected[expected.indexOf(event) - 1] ?? "start"}`,
    ).toBeGreaterThanOrEqual(0);
    from = at + 1;
  }
}

/** Asserts every directory was synced before the event first occurred. */
function syncedBefore(directories: string[], event: string): void {
  const at = events.indexOf(event);
  expect(at).toBeGreaterThan(0);
  for (const directory of directories)
    expect(events.slice(0, at)).toContain(`fsync ${directory}`);
}

describe("a backup is durable before anything relies on it", () => {
  it("syncs the whole new backup chain before an adoption commits", async () => {
    const f = fixture();
    events.length = 0;
    const set = f.store.set.bind(f.store);
    vi.spyOn(f.store, "set").mockImplementation((key, value) => {
      events.push(`set ${key}`);
      set(key, value);
    });
    await f.runtime.adoptInstructions(f.project, f.claude);
    syncedBefore(f.chain, `set instruction-adoption:${f.id}`);
  });

  it("syncs the edited file's backup chain before a forced rollback or uninstall replaces it", async () => {
    const f = fixture();
    await managedAtV2(f);
    writeFileSync(f.claude, `${v2}edited\n`);
    events.length = 0;
    f.runtime.rollbackInstructions(f.id, true);
    syncedBefore(f.chain, `rename ${f.claude}`);

    writeFileSync(f.claude, `${v2}edited again\n`);
    events.length = 0;
    f.runtime.uninstallInstructions(f.id, true);
    syncedBefore(f.chain, `rename ${f.claude}`);
  });
});

describe("the original backup goes only once the restored file is durable", () => {
  it("syncs file data, mode and directory before deleting the backup of a file already holding the original", async () => {
    const f = fixture();
    await f.runtime.adoptInstructions(f.project, f.claude);
    chmodSync(f.claude, 0o600);
    events.length = 0;
    f.runtime.uninstallInstructions(f.id);
    ordered(
      `fsync ${f.claude}`,
      `fsync ${dirname(f.claude)}`,
      `rm ${join(f.backup, sha(original).slice(7))}`,
    );
  });

  it("syncs file data, mode and directory before recovery deletes the backup", async () => {
    const f = fixture();
    await f.runtime.adoptInstructions(f.project, f.claude);
    const stopped = new Projections(f.store, (point) => {
      if (point === "after-mark") throw new Error("process stopped");
    });
    expect(() => stopped.instructions.uninstall(f.id)).toThrow("process stopped");
    events.length = 0;
    expect(f.runtime.projections.recover()).toEqual([f.id]);
    ordered(
      `fsync ${f.claude}`,
      `fsync ${dirname(f.claude)}`,
      `rm ${join(f.backup, sha(original).slice(7))}`,
    );
  });
});
