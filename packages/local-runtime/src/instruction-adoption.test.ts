import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InstructionProjections,
  LocalStore,
  LocalWorkspaceProvider,
  Projections,
  Runtime,
  RuntimeError,
  requireValue,
  type CreateRequest,
  type InstructionAdoption,
  type InstructionRecord,
  type InstructionStatus,
  type WorkspaceRef,
  targetSchema,
} from "./index.js";
import { main } from "./cli.js";

const roots: { root: string; stores: LocalStore[] }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const { root, stores } of roots.splice(0)) {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const sha = (bytes: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
// A BOM, CRLF line endings and no trailing newline must all survive byte for byte.
const original = "﻿# My agents file\r\n\r\nAlways run the tests.";
const v2 = "# Global agents\n\nPrefer small commits.\n";
const v3 = `${v2}\nReview every diff.\n`;

function fixture(
  instructions: unknown[] = [{ adapter: "claude", artifact: "global-agents" }],
  providerFactory?: (
    store: LocalStore,
  ) => (ref: WorkspaceRef) => LocalWorkspaceProvider,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-adopt-")));
  const home = join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  const state = join(home, ".skillplane");
  const store = new LocalStore(state);
  roots.push({ root, stores: [store] });
  const runtime = new Runtime(store, providerFactory?.(store));
  const project = join(root, "project");
  mkdirSync(project);
  const context = runtime.setup(project, "Personal");
  runtime.configure(project, { ...context, instructions });
  const provider = new LocalWorkspaceProvider(store, context.primary.id);
  const claude = join(home, ".claude", "CLAUDE.md");
  mkdirSync(dirname(claude));
  writeFileSync(claude, original);
  chmodSync(claude, 0o640);
  const id = InstructionProjections.id(claude);
  return { root, home, state, store, runtime, project, provider, claude, id };
}
type Fixture = ReturnType<typeof fixture>;

const adoption = (f: Fixture) =>
  f.store.get<InstructionAdoption>(`instruction-adoption:${f.id}`);
const record = (f: Fixture) => f.store.get<InstructionRecord>(`instruction:${f.id}`);
const backups = (f: Fixture) => {
  const directory = join(
    dirname(f.claude),
    ".skillplane-projections",
    "instructions",
    f.id,
    "backup",
  );
  return existsSync(directory) ? readdirSync(directory).sort() : [];
};
async function states(f: Fixture): Promise<Record<string, string>> {
  const report = (await f.runtime.doctor(false, f.project)) as {
    instructions: InstructionStatus[];
  };
  return Object.fromEntries(report.instructions.map((row) => [row.path, row.state]));
}
async function approve(
  f: Fixture,
  skillId: string,
  versionId: string,
  accept = true,
): Promise<void> {
  const rows = (await f.provider.candidates(skillId)) as {
    reviewId: string;
    expectedUpdatedAt: string;
  }[];
  const row = requireValue(rows.find((r) => r.reviewId === versionId));
  await f.provider.decide(
    skillId,
    versionId,
    row.expectedUpdatedAt,
    accept,
    "Reviewed",
    randomUUID(),
  );
}
async function publish(f: Fixture, skillId: string, text: string): Promise<void> {
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
        expectedSha256: sha(requireValue(current.bundle.files.get("AGENTS.md"))).slice(
          7,
        ),
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
const instructions = (slug: string, text: string, key = slug): CreateRequest => ({
  kind: "instructions",
  slug,
  name: slug,
  description: "",
  tags: [],
  visibility: "private",
  instructions: text,
  assets: [],
  idempotencyKey: key,
});
/** Adds a project claim on the target, as a concurrent sync elsewhere would. */
const claim = (f: Fixture) =>
  f.store.db
    .prepare("INSERT OR IGNORE INTO projection_owner VALUES (?,?)")
    .run(f.id, join(f.root, "elsewhere"));
/** Adopts the Claude file, publishes the draft and syncs it. */
async function adoptAndSync(f: Fixture) {
  const adopted = await f.runtime.adoptInstructions(f.project, f.claude);
  const draft = requireValue(adopted.draft);
  await approve(f, draft.skill.id, requireValue(draft.versionId));
  await f.runtime.sync(f.project);
  return draft.skill.id;
}

describe("instructions adopt", () => {
  it("backs the file up, imports an identical draft and leaves the file untouched until publish and sync", async () => {
    const f = fixture();
    const before = statSync(f.claude);
    const adopted = await f.runtime.adoptInstructions(f.project, f.claude);

    const saved = requireValue(adoption(f));
    expect(saved.original.digest).toBe(sha(original));
    expect(saved.original.mode).toBe(0o640);
    expect(backups(f)).toEqual([sha(original).slice(7)]);
    expect(readFileSync(saved.original.path)).toEqual(Buffer.from(original));

    const draft = requireValue(adopted.draft);
    const versions = await f.provider.versions(draft.skill.id);
    expect(versions).toEqual([expect.objectContaining({ state: "draft" })]);
    const snapshot = await f.provider.retrieve(
      draft.skill.id,
      requireValue(draft.versionId),
    );
    expect(snapshot.skill).toMatchObject({
      kind: "instructions",
      slug: "global-agents",
    });
    expect(snapshot.bundle.files.get("AGENTS.md")).toEqual(
      new Uint8Array(Buffer.from(original)),
    );

    // Nothing is published, so sync leaves the target alone and the file stays.
    expect((await f.runtime.syncTargets(f.project)).pending).toEqual([
      {
        kind: "instructions",
        id: f.id,
        path: f.claude,
        artifact: "global-agents",
        state: "adopted",
        code: "ADOPTION_PENDING_REVIEW",
      },
    ]);
    const after = statSync(f.claude);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    expect(record(f)).toBeUndefined();
    expect(await states(f)).toEqual({ [f.claude]: "adopted" });
  });

  it("takes the file over atomically once the draft is published and synced", async () => {
    const f = fixture();
    const inode = statSync(f.claude).ino;
    await adoptAndSync(f);
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    // Replaced by rename, keeping the file's mode.
    expect(statSync(f.claude).ino).not.toBe(inode);
    expect(statSync(f.claude).mode & 0o777).toBe(0o640);
    expect(record(f)).toMatchObject({ digest: sha(original), path: f.claude });
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([f.project]);
    expect(await states(f)).toEqual({ [f.claude]: "in-sync" });
  });

  it("configures an unconfigured file as a target and imports into an existing artifact for review", async () => {
    const f = fixture([]);
    const created = await f.provider.create({
      kind: "instructions",
      slug: "mine",
      name: "Mine",
      description: "",
      tags: [],
      visibility: "private",
      instructions: v2,
      assets: [],
      idempotencyKey: "create-mine",
    } satisfies CreateRequest);
    const adopted = await f.runtime.adoptInstructions(f.project, f.claude, "mine");
    expect(adopted.configured).toEqual({
      adapter: "claude",
      scope: "user",
      artifact: "mine",
    });
    expect(f.runtime.project(f.project).instructions).toEqual([adopted.configured]);
    const draft = requireValue(adopted.draft);
    expect(draft.skill.id).toBe(created.skillId);
    // The adopted content is a review candidate; the published version is unchanged.
    expect(
      (await f.provider.versions(created.skillId)).map((v) => v.state).sort(),
    ).toEqual(["pending_review", "published"]);
    // The older published version never replaces the adopted file.
    const synced = await f.runtime.syncTargets(f.project);
    expect(synced.instructions).toEqual([]);
    expect(synced.pending).toMatchObject([
      { id: f.id, code: "ADOPTION_PENDING_REVIEW" },
    ]);
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    await approve(f, created.skillId, requireValue(draft.versionId));
    await f.runtime.sync(f.project);
    expect(record(f)?.version.id).toBe(draft.versionId);
    expect(readFileSync(f.claude, "utf8")).toBe(original);
  });

  it("refuses a file edited after adoption at sync and in doctor", async () => {
    const f = fixture();
    const adopted = await f.runtime.adoptInstructions(f.project, f.claude);
    const draft = requireValue(adopted.draft);
    await approve(f, draft.skill.id, requireValue(draft.versionId));
    writeFileSync(f.claude, "edited after adopt\n");
    await expect(f.runtime.sync(f.project)).rejects.toMatchObject({
      code: "PROJECTION_DIVERGED",
    });
    expect(readFileSync(f.claude, "utf8")).toBe("edited after adopt\n");
    expect(await states(f)).toEqual({ [f.claude]: "diverged" });
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude),
    ).rejects.toMatchObject({ code: "PROJECTION_DIVERGED" });
  });

  it("completes an adopt interrupted after the backup without a second backup or draft", async () => {
    let fail = true;
    class Crashing extends LocalWorkspaceProvider {
      override async createDraft(request: CreateRequest) {
        if (fail) {
          fail = false;
          throw new Error("process stopped");
        }
        return super.createDraft(request);
      }
    }
    const f = fixture(
      undefined,
      (store) => (ref) => new Crashing(store, (ref as { id: string }).id),
    );
    await expect(f.runtime.adoptInstructions(f.project, f.claude)).rejects.toThrow(
      "process stopped",
    );
    const backedUp = requireValue(adoption(f));
    expect(backedUp.draft).toBeUndefined();
    expect(backups(f)).toEqual([sha(original).slice(7)]);
    expect(await f.provider.list("instructions")).toEqual([]);

    const adopted = await f.runtime.adoptInstructions(f.project, f.claude);
    expect(adopted.original).toEqual(backedUp.original);
    expect(backups(f)).toEqual([sha(original).slice(7)]);
    const items = await f.provider.list("instructions");
    expect(items).toHaveLength(1);
    expect(await f.provider.versions(requireValue(items[0]).id)).toHaveLength(1);
  });

  it("replays a draft created before an interruption instead of creating another", async () => {
    const f = fixture();
    const spy = vi
      .spyOn(f.runtime.projections.instructions, "recordDraft")
      .mockImplementationOnce(() => {
        throw new Error("process stopped");
      });
    await expect(f.runtime.adoptInstructions(f.project, f.claude)).rejects.toThrow(
      "process stopped",
    );
    spy.mockRestore();
    const adopted = await f.runtime.adoptInstructions(f.project, f.claude);
    const items = await f.provider.list("instructions");
    expect(items.map((item) => item.id)).toEqual([adopted.draft?.skill.id]);
    expect(await f.provider.versions(requireValue(items[0]).id)).toHaveLength(1);
    // Running it again after it completed changes nothing.
    expect(await f.runtime.adoptInstructions(f.project, f.claude)).toEqual(adopted);
  });

  it("refuses a file Skillplane already manages and a file that does not exist", async () => {
    const f = fixture();
    await adoptAndSync(f);
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude),
    ).rejects.toMatchObject({ code: "INSTRUCTIONS_MANAGED" });
    await expect(
      f.runtime.adoptInstructions(f.project, join(f.home, "missing.md"), "missing"),
    ).rejects.toMatchObject({ code: "INSTRUCTIONS_FILE_NOT_FOUND" });
  });
});

describe("instructions rollback and uninstall", () => {
  it("rolls back to the previous generation's bytes", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    const inode = statSync(f.claude).ino;
    const { record: restored, backup } = f.runtime.rollbackInstructions(f.id);
    expect(backup).toBeNull();
    expect(readFileSync(f.claude, "utf8")).toBe(original);
    expect(statSync(f.claude).ino).not.toBe(inode);
    expect(restored.digest).toBe(sha(original));
    expect(record(f)?.digest).toBe(sha(original));
    expect(await states(f)).toEqual({ [f.claude]: "in-sync" });
    // Rolling back again returns to the newer generation.
    f.runtime.rollbackInstructions(f.id);
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
  });

  it("refuses a rollback without a previous generation", async () => {
    const f = fixture();
    await adoptAndSync(f);
    expect(() => f.runtime.rollbackInstructions(f.id)).toThrow(
      expect.objectContaining({ code: "ROLLBACK_UNAVAILABLE" }),
    );
  });

  it("restores the original pre-adoption bytes on uninstall and clears projection state", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    await publish(f, skillId, v3);
    await f.runtime.sync(f.project);
    const result = f.runtime.uninstallInstructions(f.id);
    expect(result).toMatchObject({ uninstalled: f.id, backup: null });
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(statSync(f.claude).mode & 0o777).toBe(0o640);
    expect(record(f)).toBeUndefined();
    expect(adoption(f)).toBeUndefined();
    expect(f.store.entries(`instruction-history:${f.id}:`)).toEqual([]);
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([]);
    expect(backups(f)).toEqual([]);
    // The target leaves the configuration, so the next sync neither refuses
    // the restored file nor writes over it.
    expect(f.runtime.project(f.project).instructions).toEqual([]);
    expect(await f.runtime.syncTargets(f.project)).toEqual({
      projections: [],
      instructions: [],
      pending: [],
    });
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(f.store.entries("instruction-unconfigure:")).toEqual([]);
  });

  it("removes a managed file that was never adopted", async () => {
    const f = fixture();
    rmSync(f.claude);
    const created = await f.provider.create({
      kind: "instructions",
      slug: "global-agents",
      name: "Global agents",
      description: "",
      tags: [],
      visibility: "private",
      instructions: v2,
      assets: [],
      idempotencyKey: "create",
    });
    await f.runtime.sync(f.project);
    expect(record(f)?.skill.id).toBe(created.skillId);
    expect(f.runtime.uninstallInstructions(f.id).restored).toBeNull();
    expect(existsSync(f.claude)).toBe(false);
    expect(record(f)).toBeUndefined();
    // The next sync does not write the removed file again.
    expect(f.runtime.project(f.project).instructions).toEqual([]);
    expect((await f.runtime.syncTargets(f.project)).instructions).toEqual([]);
    expect(existsSync(f.claude)).toBe(false);
  });

  it("restores an adopted file that was never synced", async () => {
    const f = fixture();
    await f.runtime.adoptInstructions(f.project, f.claude);
    const result = f.runtime.uninstallInstructions(f.id);
    expect(result.restored?.digest).toBe(sha(original));
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(adoption(f)).toBeUndefined();
    expect(await states(f)).toEqual({});
    expect((await f.runtime.syncTargets(f.project)).pending).toEqual([]);
  });

  it("refuses a hand-edited file and backs it up first with force", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    const edited = `${v2}\nmy local rule\n`;
    writeFileSync(f.claude, edited);

    expect(() => f.runtime.rollbackInstructions(f.id)).toThrow(
      expect.objectContaining({ code: "PROJECTION_DIVERGED" }),
    );
    expect(() => f.runtime.uninstallInstructions(f.id)).toThrow(
      expect.objectContaining({ code: "PROJECTION_DIVERGED" }),
    );
    expect(readFileSync(f.claude, "utf8")).toBe(edited);
    expect(backups(f)).toEqual([sha(original).slice(7)]);
    expect(f.store.entries("instruction-uninstall:")).toEqual([]);

    const rolled = f.runtime.rollbackInstructions(f.id, true);
    expect(readFileSync(requireValue(rolled.backup).path, "utf8")).toBe(edited);
    expect(rolled.backup?.digest).toBe(sha(edited));
    expect(readFileSync(f.claude, "utf8")).toBe(original);

    writeFileSync(f.claude, `${edited}more\n`);
    const removed = f.runtime.uninstallInstructions(f.id, true);
    expect(readFileSync(requireValue(removed.backup).path, "utf8")).toBe(
      `${edited}more\n`,
    );
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(record(f)).toBeUndefined();
    // Backups of edited files outlive the uninstall; the restored original goes.
    expect(backups(f)).toEqual(
      [sha(edited).slice(7), sha(`${edited}more\n`).slice(7)].sort(),
    );
  });

  it("finishes an uninstall interrupted after its rename on the next run", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    const crashing = new Projections(f.store, (point) => {
      if (point === "after-rename") throw new Error("process stopped");
    });
    expect(() => crashing.instructions.uninstall(f.id)).toThrow("process stopped");
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(record(f)?.digest).toBe(sha(v2));
    // Recovery finishes it, including dropping the target from the project.
    expect(await states(f)).toEqual({});
    expect(record(f)).toBeUndefined();
    expect(adoption(f)).toBeUndefined();
    expect(f.runtime.project(f.project).instructions).toEqual([]);
    expect((await f.runtime.syncTargets(f.project)).instructions).toEqual([]);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(
      readdirSync(dirname(f.claude)).filter((n) =>
        n.startsWith(".skillplane-instructions-"),
      ),
    ).toEqual([]);
  });

  it("drops an uninstall interrupted before its rename and keeps the managed file", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    const crashing = new Projections(f.store, (point) => {
      if (point === "before-swap") throw new Error("process stopped");
    });
    expect(() => crashing.instructions.uninstall(f.id)).toThrow("process stopped");
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    expect(await states(f)).toEqual({ [f.claude]: "in-sync" });
    expect(f.store.entries("instruction-uninstall:")).toEqual([]);
    expect(
      readdirSync(dirname(f.claude)).filter((n) =>
        n.startsWith(".skillplane-instructions-"),
      ),
    ).toEqual([]);
  });

  it("commits a rollback interrupted after its rename on the next run", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    const crashing = new Projections(f.store, (point) => {
      if (point === "after-rename") throw new Error("process stopped");
    });
    expect(() => crashing.instructions.rollback(f.id)).toThrow("process stopped");
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(f.runtime.projections.recover()).toEqual([f.id]);
    expect(record(f)?.digest).toBe(sha(original));
    expect(await states(f)).toEqual({ [f.claude]: "in-sync" });
  });
});

describe("adoption lifecycle", () => {
  it("re-adopts after uninstall on the amend path, and again after the base moved", async () => {
    const f = fixture([]);
    const created = await f.provider.create(instructions("mine", v2));
    const first = await f.runtime.adoptInstructions(f.project, f.claude, "mine");
    const candidate = requireValue(first.draft).versionId;
    f.runtime.uninstallInstructions(f.id);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));

    // The candidate still awaiting review holds the bytes and is reused.
    const second = await f.runtime.adoptInstructions(f.project, f.claude, "mine");
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.draft?.versionId).toBe(candidate);

    // Once another version is published, that candidate can no longer be
    // approved, so a fresh one is imported against the new base.
    f.runtime.uninstallInstructions(f.id);
    await publish(f, created.skillId, v3);
    const third = requireValue(
      (await f.runtime.adoptInstructions(f.project, f.claude, "mine")).draft,
    );
    expect(third.versionId).not.toBe(candidate);
    await approve(f, created.skillId, third.versionId);
    await f.runtime.sync(f.project);
    expect(record(f)?.version.id).toBe(third.versionId);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });

  it("replaces a rejected draft with a fresh one, also after uninstall", async () => {
    const f = fixture();
    const first = requireValue(
      (await f.runtime.adoptInstructions(f.project, f.claude)).draft,
    );
    await approve(f, first.skill.id, first.versionId, false);
    const second = requireValue(
      (await f.runtime.adoptInstructions(f.project, f.claude)).draft,
    );
    expect(second.skill.id).toBe(first.skill.id);
    expect(second.versionId).not.toBe(first.versionId);
    await approve(f, second.skill.id, second.versionId, false);
    f.runtime.uninstallInstructions(f.id);

    // Uninstall dropped the configured name, so it is given again.
    const third = requireValue(
      (await f.runtime.adoptInstructions(f.project, f.claude, "global-agents")).draft,
    );
    expect([first.versionId, second.versionId]).not.toContain(third.versionId);
    expect(await f.provider.list("instructions")).toHaveLength(1);
    await approve(f, third.skill.id, third.versionId);
    await f.runtime.sync(f.project);
    expect(record(f)?.version.id).toBe(third.versionId);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });

  it("keeps nothing when the file is not UTF-8 or a skill holds the slug", async () => {
    const f = fixture();
    writeFileSync(f.claude, Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    // A re-run fails the same way instead of finding a half-finished adoption.
    for (let run = 0; run < 2; run++)
      await expect(
        f.runtime.adoptInstructions(f.project, f.claude),
      ).rejects.toMatchObject({ code: "INSTRUCTIONS_NOT_UTF8" });
    expect(adoption(f)).toBeUndefined();
    expect(backups(f)).toEqual([]);
    expect(await f.provider.list()).toEqual([]);

    writeFileSync(f.claude, original);
    await f.provider.create({
      ...instructions("global-agents", "Review carefully."),
      kind: "skill",
    });
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude),
    ).rejects.toMatchObject({ code: "ARTIFACT_SLUG_CONFLICT" });
    expect(adoption(f)).toBeUndefined();
    expect(backups(f)).toEqual([]);
  });

  it("syncs skills and other instruction targets while an adoption awaits review", async () => {
    const f = fixture();
    await f.runtime.adoptInstructions(f.project, f.claude);
    await f.provider.create(instructions("codex-agents", v2));
    await f.provider.create({
      ...instructions("review", "Review carefully."),
      kind: "skill",
    });
    const context = f.runtime.project(f.project);
    f.runtime.configure(f.project, {
      ...context,
      targets: [targetSchema.parse({ adapter: "claude", scope: "user" })],
      instructions: [
        ...(context.instructions ?? []),
        { adapter: "codex", artifact: "codex-agents" },
      ],
    });
    const synced = await f.runtime.syncTargets(f.project);
    expect(synced.projections.map((r) => r.name)).toEqual(["review"]);
    const codex = join(f.home, ".codex", "AGENTS.md");
    expect(synced.instructions.map((r) => r.path)).toEqual([codex]);
    expect(synced.pending).toMatchObject([{ id: f.id, state: "adopted" }]);
    expect(readFileSync(codex, "utf8")).toBe(v2);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });

  it("keeps both targets when two adopts in one project run concurrently", async () => {
    const f = fixture([]);
    const codex = join(f.home, ".codex", "AGENTS.md");
    mkdirSync(dirname(codex));
    writeFileSync(codex, v2);
    await Promise.all([
      f.runtime.adoptInstructions(f.project, f.claude, "claude-agents"),
      f.runtime.adoptInstructions(f.project, codex, "codex-agents"),
    ]);
    expect(
      (f.runtime.project(f.project).instructions ?? []).map((t) => t.artifact).sort(),
    ).toEqual(["claude-agents", "codex-agents"]);
  });

  it("refuses to configure a target configured for another artifact meanwhile", async () => {
    const f = fixture([]);
    const catalog = f.runtime.catalog.bind(f.runtime);
    vi.spyOn(f.runtime, "catalog").mockImplementationOnce(async (...args) => {
      f.runtime.configure(f.project, {
        ...f.runtime.project(f.project),
        instructions: [{ adapter: "claude", artifact: "someone-else" }],
      });
      return catalog(...args);
    });
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude, "mine"),
    ).rejects.toMatchObject({ code: "PROJECTION_COLLISION" });
    expect(f.runtime.project(f.project).instructions).toEqual([
      { adapter: "claude", scope: "user", artifact: "someone-else" },
    ]);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });
});

describe("one adoption lifecycle at a time", () => {
  it("refuses a draft imported for an adoption uninstalled and adopted again meanwhile", async () => {
    const paused: { fixture?: Fixture } = {};
    class Pausing extends LocalWorkspaceProvider {
      override async createDraft(request: CreateRequest, skillId?: string) {
        const created = await super.createDraft(request, skillId);
        const g = paused.fixture;
        if (g) {
          delete paused.fixture;
          g.runtime.uninstallInstructions(g.id);
          writeFileSync(g.claude, v2);
          await g.runtime.adoptInstructions(g.project, g.claude, "global-agents");
        }
        return created;
      }
    }
    const f = fixture(
      undefined,
      (store) => (ref) => new Pausing(store, (ref as { id: string }).id),
    );
    paused.fixture = f;
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude),
    ).rejects.toMatchObject({
      code: "PROJECTION_CHANGED",
    });
    const current = requireValue(requireValue(adoption(f)).draft);
    const snapshot = await f.provider.retrieve(current.skill.id, current.versionId);
    expect(snapshot.bundle.files.get("AGENTS.md")).toEqual(
      new Uint8Array(Buffer.from(v2)),
    );
    expect(requireValue(adoption(f)).original.digest).toBe(sha(v2));
  });

  it("keeps nothing for a file the import refuses, and a corrected re-run succeeds", async () => {
    const f = fixture();
    for (const content of ["", " \n\t", "a\0b", "x".repeat(2 * 1024 * 1024 + 1)]) {
      writeFileSync(f.claude, content);
      await expect(
        f.runtime.adoptInstructions(f.project, f.claude),
      ).rejects.toMatchObject({ code: "INSTRUCTIONS_INVALID" });
      expect(adoption(f)).toBeUndefined();
      expect(backups(f)).toEqual([]);
    }
    expect(await f.provider.list()).toEqual([]);
    writeFileSync(f.claude, original);
    const adopted = await f.runtime.adoptInstructions(f.project, f.claude);
    expect(adopted.original.digest).toBe(sha(original));
    expect(adopted.draft).toBeDefined();
  });

  it("re-imports a draft whose base another publication moved, and takes over only once it is published", async () => {
    const f = fixture([]);
    const created = await f.provider.create(instructions("mine", v2));
    const stale = requireValue(
      (await f.runtime.adoptInstructions(f.project, f.claude, "mine")).draft,
    );
    // A version created after the draft is published over the draft's base.
    await publish(f, created.skillId, v3);
    expect((await f.runtime.syncTargets(f.project)).pending).toMatchObject([
      { id: f.id, code: "ADOPTION_PENDING_REVIEW" },
    ]);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(record(f)).toBeUndefined();

    const fresh = requireValue(
      (await f.runtime.adoptInstructions(f.project, f.claude, "mine")).draft,
    );
    expect(fresh.versionId).not.toBe(stale.versionId);
    await approve(f, created.skillId, fresh.versionId);
    await f.runtime.sync(f.project);
    expect(record(f)?.version.id).toBe(fresh.versionId);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });

  it("does not write an older version to a deleted adopted file while its draft awaits review", async () => {
    const f = fixture([]);
    const created = await f.provider.create(instructions("mine", v2));
    const draft = requireValue(
      (await f.runtime.adoptInstructions(f.project, f.claude, "mine")).draft,
    );
    rmSync(f.claude);
    expect((await f.runtime.syncTargets(f.project)).pending).toMatchObject([
      { id: f.id, code: "ADOPTION_PENDING_REVIEW" },
    ]);
    // doctor reports the absent adopted target as sync does.
    expect(await states(f)).toEqual({ [f.claude]: "adopted" });
    expect(existsSync(f.claude)).toBe(false);
    expect(record(f)).toBeUndefined();
    await approve(f, created.skillId, draft.versionId);
    await f.runtime.sync(f.project);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });

  it("reports an adopt interrupted before its draft as adopted in doctor and sync", async () => {
    const f = fixture();
    await f.provider.create(instructions("global-agents", v2));
    vi.spyOn(f.runtime.projections.instructions, "recordDraft").mockImplementationOnce(
      () => {
        throw new Error("process stopped");
      },
    );
    await expect(f.runtime.adoptInstructions(f.project, f.claude)).rejects.toThrow(
      "process stopped",
    );
    expect(await states(f)).toEqual({ [f.claude]: "adopted" });
    expect((await f.runtime.syncTargets(f.project)).pending).toMatchObject([
      { id: f.id, code: "ADOPTION_INCOMPLETE" },
    ]);
  });

  it("reports an adopt interrupted before its artifact existed as adopted, file present or absent", async () => {
    let fail = true;
    class Crashing extends LocalWorkspaceProvider {
      override async createDraft(request: CreateRequest) {
        if (fail) {
          fail = false;
          throw new Error("process stopped");
        }
        return super.createDraft(request);
      }
    }
    // The target is configured, so its name resolves to no artifact yet.
    const f = fixture(
      undefined,
      (store) => (ref) => new Crashing(store, (ref as { id: string }).id),
    );
    await expect(f.runtime.adoptInstructions(f.project, f.claude)).rejects.toThrow(
      "process stopped",
    );
    expect(await f.provider.list("instructions")).toEqual([]);
    expect(await states(f)).toEqual({ [f.claude]: "adopted" });
    expect((await f.runtime.syncTargets(f.project)).pending).toMatchObject([
      { id: f.id, state: "adopted", code: "ADOPTION_INCOMPLETE" },
    ]);
    rmSync(f.claude);
    expect(await states(f)).toEqual({ [f.claude]: "adopted" });
    expect((await f.runtime.syncTargets(f.project)).pending).toMatchObject([
      { id: f.id, state: "adopted", code: "ADOPTION_INCOMPLETE" },
    ]);
    // Another missing name keeps its catalog error.
    const other = join(f.home, ".codex", "AGENTS.md");
    f.runtime.configure(f.project, {
      ...f.runtime.project(f.project),
      instructions: [
        { adapter: "claude", artifact: "global-agents" },
        { adapter: "codex", artifact: "missing" },
      ],
    });
    expect((await states(f))[other]).toBe("INSTRUCTIONS_NOT_FOUND");
  });

  it("refuses an adopt the project configuration cannot hold before backing anything up", async () => {
    const targets = Array.from({ length: 20 }, (_, index) => ({
      adapter: "generic",
      path: `~/unused-${index}/AGENTS.md`,
      artifact: `target-${index}`,
    }));
    const f = fixture(targets);
    const error: unknown = await f.runtime
      .adoptInstructions(f.project, f.claude)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeError);
    expect(error).toMatchObject({ code: "PROJECT_CONFIG_INVALID" });
    expect(adoption(f)).toBeUndefined();
    expect(backups(f)).toEqual([]);
    expect(await f.provider.list()).toEqual([]);
    expect(f.runtime.project(f.project).instructions).toHaveLength(20);
  });

  it("does not write a target uninstalled after the sync read the configuration", async () => {
    const f = fixture();
    rmSync(f.claude);
    await f.provider.create(instructions("global-agents", v2));
    await f.runtime.sync(f.project);
    const instructionsProjections = f.runtime.projections.instructions;
    const check = instructionsProjections.check.bind(instructionsProjections);
    vi.spyOn(instructionsProjections, "check").mockImplementationOnce((...args) => {
      check(...args);
      f.runtime.uninstallInstructions(f.id);
    });
    await expect(f.runtime.syncTargets(f.project)).rejects.toMatchObject({
      code: "PROJECTION_CHANGED",
    });
    expect(existsSync(f.claude)).toBe(false);
    expect(record(f)).toBeUndefined();
    // The next sync reads the configuration uninstall released the target from.
    expect((await f.runtime.syncTargets(f.project)).instructions).toEqual([]);
    expect(existsSync(f.claude)).toBe(false);
  });

  it("does not configure a target uninstalled while it was being adopted", async () => {
    const f = fixture([]);
    const instructionsProjections = f.runtime.projections.instructions;
    const recordDraft = instructionsProjections.recordDraft.bind(
      instructionsProjections,
    );
    vi.spyOn(instructionsProjections, "recordDraft").mockImplementationOnce(
      (...args) => {
        const recorded = recordDraft(...args);
        f.runtime.uninstallInstructions(f.id);
        return recorded;
      },
    );
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude, "mine"),
    ).rejects.toMatchObject({ code: "PROJECTION_CHANGED" });
    expect(f.runtime.project(f.project).instructions).toEqual([]);
    expect(adoption(f)).toBeUndefined();
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect((await f.runtime.syncTargets(f.project)).instructions).toEqual([]);
  });
});

describe("ownership is checked in the commit that changes the target", () => {
  it("refuses an uninstall once another project claims the target after it was planned", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    const racing = new Projections(f.store, (point) => {
      if (point === "after-mark") claim(f);
    });
    expect(() => racing.instructions.uninstall(f.id)).toThrow(
      expect.objectContaining({ code: "PROJECTION_SHARED" }),
    );
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    expect(record(f)?.digest).toBe(sha(v2));
    expect(adoption(f)).toBeDefined();
    expect(f.store.entries("instruction-uninstall:")).toEqual([]);
  });

  it("refuses a rollback to another artifact once another project claims the target", async () => {
    const f = fixture();
    rmSync(f.claude);
    await f.provider.create(instructions("global-agents", v2));
    await f.provider.create(instructions("other", v3));
    await f.runtime.sync(f.project);
    f.runtime.configure(f.project, {
      ...f.runtime.project(f.project),
      instructions: [{ adapter: "claude", artifact: "other" }],
    });
    await f.runtime.sync(f.project);
    expect(readFileSync(f.claude, "utf8")).toBe(v3);
    const racing = new Projections(f.store, (point) => {
      if (point === "after-stage") claim(f);
    });
    expect(() => racing.instructions.rollback(f.id)).toThrow(
      expect.objectContaining({ code: "PROJECTION_SHARED" }),
    );
    expect(readFileSync(f.claude, "utf8")).toBe(v3);
    expect(record(f)?.digest).toBe(sha(v3));
  });

  it("does not claim a target uninstalled and synced by another project after the sync planned it", async () => {
    const f = fixture();
    rmSync(f.claude);
    const created = await f.provider.create(instructions("global-agents", v2));
    await f.runtime.sync(f.project);
    await publish(f, created.skillId, v3);
    const snapshot = await f.provider.retrieve(created.skillId);
    const target = { adapter: "claude", artifact: "global-agents" } as const;
    const other = join(f.root, "other");
    const instructionsProjections = f.runtime.projections.instructions;
    let paused = false;
    const planned = new Projections(f.store, (point) => {
      if (point !== "before-write" || paused) return;
      paused = true;
      // This sync planned the write; the others go ahead before it stages.
      instructionsProjections.uninstall(f.id);
      instructionsProjections.sync(snapshot, target, other, {
        releases: instructionsProjections.releases(),
      });
    });
    const plan = { releases: planned.instructions.releases() };
    expect(() => planned.instructions.sync(snapshot, target, f.project, plan)).toThrow(
      expect.objectContaining({ code: "PROJECTION_CHANGED" }),
    );
    expect(paused).toBe(true);
    expect(instructionsProjections.owners(f.id)).toEqual([other]);
    expect(readFileSync(f.claude, "utf8")).toBe(v3);
    // The other project's uninstall is not blocked by a claim from the stale plan.
    expect(instructionsProjections.uninstall(f.id).restored).toBeNull();
    expect(existsSync(f.claude)).toBe(false);
    expect(instructionsProjections.owners(f.id)).toEqual([]);
  });
  it("recovers an interrupted rollback without claiming a target its writer no longer configures", async () => {
    const f = fixture();
    rmSync(f.claude);
    const created = await f.provider.create(instructions("global-agents", v2));
    await f.runtime.sync(f.project);
    await publish(f, created.skillId, v3);
    await f.runtime.sync(f.project);
    const snapshot = await f.provider.retrieve(created.skillId);
    const other = join(f.root, "other");
    const instructionsProjections = f.runtime.projections.instructions;
    // The other project syncs the same version: a no-op that only claims it.
    instructionsProjections.sync(
      snapshot,
      { adapter: "claude", artifact: "global-agents" },
      other,
      { releases: instructionsProjections.releases() },
    );
    f.runtime.configure(f.project, {
      ...f.runtime.project(f.project),
      instructions: [],
    });
    await f.runtime.sync(f.project);
    expect(instructionsProjections.owners(f.id)).toEqual([other]);
    expect(record(f)?.project).toBe(f.project);

    const crashing = new Projections(f.store, (point) => {
      if (point === "after-rename") throw new Error("process stopped");
    });
    expect(() => crashing.instructions.rollback(f.id)).toThrow("process stopped");
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    expect(f.runtime.projections.recover()).toEqual([f.id]);
    expect(record(f)?.digest).toBe(sha(v2));
    expect(instructionsProjections.owners(f.id)).toEqual([other]);
    expect(instructionsProjections.uninstall(f.id).restored).toBeNull();
    expect(existsSync(f.claude)).toBe(false);
    expect(instructionsProjections.owners(f.id)).toEqual([]);
  });
});

describe("an uninstall never races a write that may still land", () => {
  const setWriter = (f: Fixture, pid: number) => {
    for (const [key, journal] of f.store.entries<{ pid: number }>(
      `instruction-journal:${f.id}:`,
    ))
      f.store.set(key, { ...journal, pid });
  };
  /** Adopts the file, publishes the draft and crashes the first sync after its rename. */
  async function crashFirstSync(f: Fixture) {
    const adopted = await f.runtime.adoptInstructions(f.project, f.claude);
    const draft = requireValue(adopted.draft);
    await approve(f, draft.skill.id, requireValue(draft.versionId));
    const snapshot = await f.provider.retrieve(draft.skill.id);
    const target = { adapter: "claude", artifact: "global-agents" } as const;
    const crashing = new Projections(f.store, (point) => {
      if (point === "after-rename") throw new Error("commit failed");
    });
    expect(() =>
      crashing.instructions.sync(snapshot, target, f.project, {
        releases: crashing.instructions.releases(),
      }),
    ).toThrow("commit failed");
    // The writer's process is still running elsewhere, so its journal stays.
    setWriter(f, process.ppid);
    expect(f.store.entries(`instruction-journal:${f.id}:`)).toHaveLength(1);
    expect(record(f)).toBeUndefined();
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  }
  // This process has no write in flight, so its own pid marks a stopped writer.
  const stopWriter = (f: Fixture) => setWriter(f, process.pid);

  it("refuses an uninstall while a renamed but uncommitted write's process is alive", async () => {
    const f = fixture();
    await crashFirstSync(f);
    const [backup] = backups(f);
    expect(() => f.runtime.projections.instructions.uninstall(f.id)).toThrow(
      expect.objectContaining({ code: "PROJECTION_BUSY" }),
    );
    expect(adoption(f)).toBeDefined();
    expect(backups(f)).toEqual([backup]);
    expect(f.store.entries("instruction-uninstall:")).toEqual([]);

    // Once the writer stops, recovery commits its write and uninstall restores
    // the original, which stays in place.
    stopWriter(f);
    expect(() => f.runtime.projections.instructions.uninstall(f.id)).toThrow(
      expect.objectContaining({ code: "RECOVERY_PENDING" }),
    );
    expect(f.runtime.projections.recover()).toEqual([f.id]);
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([f.project]);
    expect(f.runtime.projections.instructions.uninstall(f.id).restored).not.toBeNull();
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(record(f)).toBeUndefined();
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([]);
    expect(f.runtime.projections.recover()).toEqual([]);
    expect(record(f)).toBeUndefined();
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });

  it("recovers no record or claim for a write whose target was released since", async () => {
    const f = fixture();
    await crashFirstSync(f);
    stopWriter(f);
    // A release the journal did not see, as an uninstall would leave.
    f.store.set(`instruction-release:${f.id}`, "released-since");
    expect(f.runtime.projections.recover()).toEqual([]);
    expect(f.store.entries(`instruction-journal:${f.id}:`)).toEqual([]);
    expect(record(f)).toBeUndefined();
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([]);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });
});

describe("an interrupted uninstall is recovered only once it is durable", () => {
  const failingSync = (f: Fixture) =>
    new Projections(f.store, (point) => {
      if (point === "before-recover-sync") throw new Error("fsync failed");
    });

  it("keeps the marker and ownership of a restore when its directory cannot be synced", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    const crashing = new Projections(f.store, (point) => {
      if (point === "after-rename") throw new Error("process stopped");
    });
    expect(() => crashing.instructions.uninstall(f.id)).toThrow("process stopped");
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));

    expect(failingSync(f).recover()).toEqual([]);
    expect(f.store.entries("instruction-uninstall:")).toHaveLength(1);
    expect(record(f)).toBeDefined();
    expect(adoption(f)).toBeDefined();
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([f.project]);
    expect(f.store.entries("instruction-unconfigure:")).toEqual([]);

    expect(f.runtime.projections.recover()).toEqual([f.id]);
    expect(f.store.entries("instruction-uninstall:")).toEqual([]);
    expect(record(f)).toBeUndefined();
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([]);
    // The original's copy goes with the adoption, as after an uninstall.
    expect(backups(f)).toEqual([]);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });

  it("keeps the marker and ownership of a removal when its directory cannot be synced", async () => {
    const f = fixture();
    rmSync(f.claude);
    await f.provider.create(instructions("global-agents", v2));
    await f.runtime.sync(f.project);
    const crashing = new Projections(f.store, (point) => {
      if (point !== "before-unlink") return;
      rmSync(f.claude);
      throw new Error("process stopped");
    });
    expect(() => crashing.instructions.uninstall(f.id)).toThrow("process stopped");
    expect(existsSync(f.claude)).toBe(false);

    expect(failingSync(f).recover()).toEqual([]);
    expect(f.store.entries("instruction-uninstall:")).toHaveLength(1);
    expect(record(f)?.digest).toBe(sha(v2));
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([f.project]);

    expect(f.runtime.projections.recover()).toEqual([f.id]);
    expect(record(f)).toBeUndefined();
    expect(f.runtime.projections.instructions.owners(f.id)).toEqual([]);
    expect((await f.runtime.syncTargets(f.project)).instructions).toEqual([]);
    expect(existsSync(f.claude)).toBe(false);
  });
});

describe("instructions CLI", () => {
  it("adopts by path, routes rollback and uninstall by target and scopes the flags", async () => {
    const f = fixture();
    f.store.close();
    roots.at(-1)?.stores.splice(0);
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => output.push(line));
    const run = async (...args: string[]) => {
      output.length = 0;
      await main([...args, "--home", f.state, "--project", f.project]);
      return JSON.parse(requireValue(output[0])) as Record<string, unknown>;
    };
    const adopted = await run("instructions", "adopt", "~/.claude/CLAUDE.md");
    expect(adopted).toMatchObject({
      id: f.id,
      path: f.claude,
      artifact: "global-agents",
    });
    await expect(run("sync", "--artifact", "x")).rejects.toMatchObject({
      code: "ARGUMENT_INVALID",
    });
    await expect(run("rollback", "0123456789abcdef", "--force")).rejects.toMatchObject({
      code: "ARGUMENT_INVALID",
    });
    // A bare file name in the working directory names the adopted target.
    vi.spyOn(process, "cwd").mockReturnValue(dirname(f.claude));
    expect(await run("uninstall", "CLAUDE.md")).toMatchObject({
      uninstalled: f.id,
    });
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });
});

describe("uninstall decides divergence apart from restoration", () => {
  it("refuses a managed file hand-edited back to the original, and restores its mode with force", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    writeFileSync(f.claude, original);
    chmodSync(f.claude, 0o666);

    expect(() => f.runtime.uninstallInstructions(f.id)).toThrow(
      expect.objectContaining({ code: "PROJECTION_DIVERGED" }),
    );
    expect(record(f)?.digest).toBe(sha(v2));
    expect(adoption(f)).toBeDefined();
    expect(backups(f)).toEqual([sha(original).slice(7)]);

    const removed = f.runtime.uninstallInstructions(f.id, true);
    expect(removed.backup?.digest).toBe(sha(original));
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(statSync(f.claude).mode & 0o777).toBe(0o640);
    expect(record(f)).toBeUndefined();
    // The forced backup holds the edited bytes and outlives the uninstall.
    expect(backups(f)).toEqual([sha(original).slice(7)]);
  });

  it("restores the saved mode of an adopted file that still holds the original bytes", async () => {
    const f = fixture();
    await f.runtime.adoptInstructions(f.project, f.claude);
    chmodSync(f.claude, 0o600);
    f.runtime.uninstallInstructions(f.id);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
    expect(statSync(f.claude).mode & 0o777).toBe(0o640);
    expect(adoption(f)).toBeUndefined();
    expect(backups(f)).toEqual([]);
  });

  it("recovers an interrupted uninstall only once the saved mode is restored", async () => {
    const f = fixture();
    await f.runtime.adoptInstructions(f.project, f.claude);
    chmodSync(f.claude, 0o600);
    const stopped = new Projections(f.store, (point) => {
      if (point === "after-mark") throw new Error("process stopped");
    });
    expect(() => stopped.instructions.uninstall(f.id)).toThrow("process stopped");
    const failing = new Projections(f.store, (point) => {
      if (point === "before-recover-sync") throw new Error("fsync failed");
    });
    expect(failing.recover()).toEqual([]);
    expect(f.store.entries("instruction-uninstall:")).toHaveLength(1);
    expect(adoption(f)).toBeDefined();
    expect(backups(f)).toEqual([sha(original).slice(7)]);
    expect(statSync(f.claude).mode & 0o777).toBe(0o600);

    expect(f.runtime.projections.recover()).toEqual([f.id]);
    expect(statSync(f.claude).mode & 0o777).toBe(0o640);
    expect(adoption(f)).toBeUndefined();
    expect(backups(f)).toEqual([]);
    expect(readFileSync(f.claude)).toEqual(Buffer.from(original));
  });
  it("recovers an uninstall only once its own restore landed, never a hand-edit to the original", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    const stopped = new Projections(f.store, (point) => {
      if (point === "after-mark") throw new Error("process stopped");
    });
    expect(() => stopped.instructions.uninstall(f.id)).toThrow("process stopped");
    writeFileSync(f.claude, original);
    expect(f.runtime.projections.recover()).toEqual([]);
    expect(f.store.entries("instruction-uninstall:")).toEqual([]);
    expect(record(f)?.digest).toBe(sha(v2));
    expect(adoption(f)).toBeDefined();
    expect(backups(f)).toEqual([sha(original).slice(7)]);
    expect(
      readdirSync(dirname(f.claude)).filter((n) =>
        n.startsWith(".skillplane-instructions-"),
      ),
    ).toEqual([]);
  });

  it("keeps a forced backup sharing the original's copy when recovery finishes the uninstall", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    writeFileSync(f.claude, original);
    const stopped = new Projections(f.store, (point) => {
      if (point === "after-mark") throw new Error("process stopped");
    });
    expect(() => stopped.instructions.uninstall(f.id, true)).toThrow("process stopped");
    expect(f.runtime.projections.recover()).toEqual([f.id]);
    expect(record(f)).toBeUndefined();
    expect(backups(f)).toEqual([sha(original).slice(7)]);
    expect(statSync(f.claude).mode & 0o777).toBe(0o640);
  });
});

describe("PR review round 1 adoption and rollback checks", () => {
  it("rolls back to the generation the current one replaced, even with the same bytes", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    // Another artifact with the same bytes replaces it.
    const other = await f.provider.create(instructions("other-agents", v2));
    f.runtime.configure(f.project, {
      ...f.runtime.project(f.project),
      instructions: [{ adapter: "claude", artifact: "other-agents" }],
    });
    await f.runtime.sync(f.project);
    expect(record(f)?.skill.id).toBe(other.skillId);
    const { record: restored } = f.runtime.rollbackInstructions(f.id);
    expect(restored.skill.id).toBe(skillId);
    expect(restored.digest).toBe(sha(v2));
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
  });

  it("rolls back to the latest replaced generation by commit order, not timestamp", async () => {
    const f = fixture();
    const skillId = await adoptAndSync(f);
    await publish(f, skillId, v2);
    await f.runtime.sync(f.project);
    await publish(f, skillId, v3);
    await f.runtime.sync(f.project);
    // A clock that stepped back gives the older generation the later time.
    const history = f.store.entries<InstructionRecord>(`instruction-history:${f.id}:`);
    expect(history).toHaveLength(2);
    for (const [key, value] of history)
      f.store.set(key, {
        ...value,
        synchronizedAt:
          value.digest === sha(original)
            ? "2030-01-01T00:00:00.000Z"
            : "2020-01-01T00:00:00.000Z",
      });
    const { record: restored } = f.runtime.rollbackInstructions(f.id);
    expect(restored.digest).toBe(sha(v2));
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    expect(record(f)).not.toHaveProperty("sequence");
  });

  it("records the published version that already holds the adopted bytes, as no draft can repeat it", async () => {
    const f = fixture();
    const created = await f.provider.create(instructions("global-agents", v2));
    writeFileSync(f.claude, v2);
    const current = await f.provider.retrieve(created.skillId);
    // The provider refuses a version identical to the published one.
    await expect(
      f.provider.amend({
        skillId: created.skillId,
        baseVersionId: current.version.id,
        proposedBump: "minor",
        idempotencyKey: randomUUID(),
        changes: [
          {
            operation: "replace",
            path: "AGENTS.md",
            expectedSha256: sha(v2).slice(7),
            content: v2,
          },
        ],
        learning: {
          summary: "Same",
          observation: "Same",
          rationale: "Same",
          confidence: "high",
          evidence: [],
          evidenceUnavailableReason: "Same",
          validation: [],
          validationNotRunReason: "Same",
          sourceContextId: null,
          tags: [],
          externalReferences: [],
          extra: {},
        },
      }),
    ).rejects.toMatchObject({ code: "UNCHANGED_BUNDLE" });
    const adopted = await f.runtime.adoptInstructions(f.project, f.claude);
    expect(adopted.draft?.versionId).toBe(current.version.id);
    expect(backups(f)).toEqual([sha(v2).slice(7)]);
    // The reviewed bytes are the file's bytes, so the takeover changes nothing.
    await f.runtime.sync(f.project);
    expect(record(f)?.digest).toBe(sha(v2));
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
  });

  it("refuses an adopt when a skill shares the slug of a visible instructions artifact", async () => {
    const f = fixture();
    await f.provider.create(instructions("global-agents", v2));
    const skill = await f.provider.create({
      ...instructions("review", "Review carefully."),
      kind: "skill",
    });
    // A store from before slugs were unique across kinds may hold both.
    f.store.db
      .prepare("UPDATE skill SET slug='global-agents' WHERE id=?")
      .run(skill.skillId);
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude),
    ).rejects.toMatchObject({ code: "ARTIFACT_SLUG_CONFLICT" });
    expect(adoption(f)).toBeUndefined();
    expect(backups(f)).toEqual([]);
  });

  it("refuses an adopt into a configuration sync refuses, before any write", async () => {
    const f = fixture([
      { adapter: "claude", artifact: "global-agents" },
      { adapter: "generic", path: "~/.claude/CLAUDE.md", artifact: "global-agents" },
    ]);
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude),
    ).rejects.toMatchObject({ code: "PROJECTION_COLLISION" });
    expect(adoption(f)).toBeUndefined();
    expect(backups(f)).toEqual([]);
    expect(await f.provider.list()).toEqual([]);
  });

  it("keeps the destination of an adoption awaiting review from a skill, even once its file is deleted", async () => {
    const f = fixture([]);
    const rules = join(f.home, "rules");
    const file = join(rules, "review");
    mkdirSync(rules);
    writeFileSync(file, v2);
    await f.runtime.adoptInstructions(f.project, file, "rules");
    rmSync(file);
    await f.provider.create({
      ...instructions("review", "Review carefully."),
      kind: "skill",
    });
    f.runtime.configure(f.project, {
      ...f.runtime.project(f.project),
      targets: [targetSchema.parse({ adapter: "generic", directory: rules })],
    });
    await expect(f.runtime.syncTargets(f.project)).rejects.toMatchObject({
      code: "PROJECTION_COLLISION",
      message: expect.stringContaining("overlaps skill destination"),
    });
    expect(existsSync(file)).toBe(false);
  });

  it("refuses to configure an adoption whose workspaces changed meanwhile, and a re-run imports into the new primary", async () => {
    const f = fixture([]);
    const team = LocalWorkspaceProvider.create(f.store, "Team");
    const catalog = f.runtime.catalog.bind(f.runtime);
    vi.spyOn(f.runtime, "catalog").mockImplementationOnce(async (...args) => {
      const result = await catalog(...args);
      f.runtime.configure(f.project, {
        ...f.runtime.project(f.project),
        primary: team.workspace,
      });
      return result;
    });
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude, "mine"),
    ).rejects.toMatchObject({ code: "PROJECTION_CHANGED" });
    expect(f.runtime.project(f.project).instructions ?? []).toEqual([]);

    const adopted = await f.runtime.adoptInstructions(f.project, f.claude, "mine");
    expect(adopted.draft?.workspace).toEqual(team.workspace);
    expect(f.runtime.project(f.project).instructions).toEqual([
      { adapter: "claude", scope: "user", artifact: "mine" },
    ]);
    expect(backups(f)).toEqual([sha(original).slice(7)]);
  });

  it("refuses to configure a draft another run recorded for a workspace the project left", async () => {
    const f = fixture([]);
    const personal = f.runtime.project(f.project).primary;
    const team = LocalWorkspaceProvider.create(f.store, "Team");
    f.runtime.configure(f.project, {
      ...f.runtime.project(f.project),
      primary: team.workspace,
    });
    const instructionsState = f.runtime.projections.instructions;
    const record = instructionsState.recordDraft.bind(instructionsState);
    // A run that started in the personal workspace records its draft first.
    vi.spyOn(instructionsState, "recordDraft").mockImplementationOnce(
      (id, nonce, draft, replaced) => {
        record(id, nonce, { ...draft, workspace: personal }, replaced);
        return record(id, nonce, draft, replaced);
      },
    );
    await expect(
      f.runtime.adoptInstructions(f.project, f.claude, "mine"),
    ).rejects.toMatchObject({ code: "PROJECTION_CHANGED" });
    expect(f.runtime.project(f.project).instructions ?? []).toEqual([]);
    const adopted = await f.runtime.adoptInstructions(f.project, f.claude, "mine");
    expect(adopted.draft?.workspace).toEqual(team.workspace);
  });

  it("derives a default artifact by trimming one hyphen at each edge", async () => {
    const f = fixture([]);
    const file = join(f.home, "notes", "__Team Rules__.md");
    mkdirSync(dirname(file));
    writeFileSync(file, v2);
    const adopted = await f.runtime.adoptInstructions(f.project, file);
    expect(adopted.artifact).toBe("team-rules");
  });
});
