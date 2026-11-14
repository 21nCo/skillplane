import {
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
  instructionTargetSchema,
  projectSchema,
  requireValue,
  targetSchema,
  workspaceKey,
  type CreateRequest,
  type InstructionRecord,
  type InstructionStatus,
} from "./index.js";

const resources: { root: string; stores: LocalStore[] }[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const { root, stores } of resources.splice(0)) {
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const sha = (text: string | Uint8Array) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;
const v1 = "# Global agents\n\nUse the composio CLI when no connector exists.\n";
const v2 = `${v1}\nTry every ACTIVE account per provider.\n`;
const request: CreateRequest = {
  kind: "instructions",
  slug: "global-agents",
  name: "Global agents",
  description: "User-level agent instructions",
  tags: [],
  visibility: "private",
  instructions: v1,
  assets: [],
  idempotencyKey: "create-global-agents",
};

function fixture(
  instructions: unknown[] = [
    { adapter: "claude", artifact: "global-agents" },
    { adapter: "codex", artifact: "global-agents" },
  ],
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-instr-")));
  const home = join(root, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  const state = join(root, "home", ".skillplane");
  const store = new LocalStore(state);
  const resource = { root, stores: [store] };
  resources.push(resource);
  const runtime = new Runtime(store);
  const project = join(root, "project");
  mkdirSync(project);
  const context = runtime.setup(project, "Personal");
  runtime.configure(project, { ...context, instructions });
  const provider = new LocalWorkspaceProvider(store, context.primary.id);
  const claude = join(home, ".claude", "CLAUDE.md");
  const codex = join(home, ".codex", "AGENTS.md");
  /** A second connection to the same state, as another Skillplane process has. */
  const reopen = () => {
    const other = new LocalStore(state);
    resource.stores.push(other);
    return other;
  };
  return { root, home, store, runtime, project, provider, claude, codex, reopen };
}

async function publish(
  provider: LocalWorkspaceProvider,
  skillId: string,
  text: string,
): Promise<void> {
  const current = await provider.retrieve(skillId);
  const amended = await provider.amend({
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
      summary: "Update global instructions",
      observation: "Accounts were skipped",
      rationale: "Try each active account",
      confidence: "high",
      evidence: [],
      evidenceUnavailableReason: "Editorial update",
      validation: [],
      validationNotRunReason: "No executable change",
    },
  });
  const rows = (await provider.candidates(skillId)) as {
    reviewId: string;
    expectedUpdatedAt: string;
  }[];
  const row = requireValue(rows.find((r) => r.reviewId === amended.versionId));
  await provider.decide(
    skillId,
    amended.versionId,
    row.expectedUpdatedAt,
    true,
    "Reviewed",
    randomUUID(),
  );
}

const record = (store: LocalStore, path: string) =>
  store.get<InstructionRecord>(`instruction:${InstructionProjections.id(path)}`);
interface Doctor {
  instructions: InstructionStatus[];
}
const states = async (runtime: Runtime, project: string) =>
  Object.fromEntries(
    ((await runtime.doctor(false, project)) as Doctor).instructions.map((row) => [
      row.path,
      row.state,
    ]),
  );

describe("instruction target configuration", () => {
  it("validates adapters, scope and paths and stays readable by older runtimes", () => {
    const parse = (value: unknown) => instructionTargetSchema.safeParse(value).success;
    expect(parse({ adapter: "claude", artifact: "global" })).toBe(true);
    expect(parse({ adapter: "generic", artifact: "global", path: "~/RULES.md" })).toBe(
      true,
    );
    expect(parse({ adapter: "generic", artifact: "global" })).toBe(false);
    expect(
      parse({ adapter: "codex", artifact: "global", path: "relative/AGENTS.md" }),
    ).toBe(false);
    expect(parse({ adapter: "codex", artifact: "global", path: "/tmp/dir/" })).toBe(
      false,
    );
    expect(parse({ adapter: "codex", artifact: "global", path: "/tmp/.." })).toBe(
      false,
    );
    expect(parse({ adapter: "codex", artifact: "global", scope: "project" })).toBe(
      false,
    );
    expect(parse({ adapter: "codex", artifact: "Global" })).toBe(false);
    // Published runtimes parse skillplane.json strictly, so a context without
    // instruction targets must not gain the key.
    const context = projectSchema.parse({
      formatVersion: 1,
      primary: { provider: "local", id: randomUUID() },
    });
    expect(Object.keys(context)).not.toContain("instructions");
  });
});

describe("instruction file projection", () => {
  it("writes the exact published bytes to both default files and records their digests", async () => {
    const f = fixture();
    const created = await f.provider.create(request);
    const synced = await f.runtime.syncTargets(f.project);
    expect(synced.projections).toEqual([]);
    expect(synced.instructions.map((r) => r.path)).toEqual([f.claude, f.codex]);
    for (const path of [f.claude, f.codex]) {
      expect(readFileSync(path, "utf8")).toBe(v1);
      const saved = requireValue(record(f.store, path));
      expect(saved).toMatchObject({
        kind: "instructions",
        path,
        digest: sha(v1),
        version: { id: created.versionId, semanticVersion: "1.0.0" },
        skill: { id: created.skillId, kind: "instructions" },
      });
      expect(readFileSync(saved.generation, "utf8")).toBe(v1);
      expect(saved.generation).toContain(
        join(dirname(path), ".skillplane-projections", "instructions", saved.id),
      );
      // No launcher wrapper, temp files or skill directories beside the target.
      expect(readdirSync(dirname(path)).sort()).toEqual(
        [
          ".skillplane-projections",
          path.endsWith("CLAUDE.md") ? "CLAUDE.md" : "AGENTS.md",
        ].sort(),
      );
    }
    expect(await states(f.runtime, f.project)).toEqual({
      [f.claude]: "in-sync",
      [f.codex]: "in-sync",
    });
    // A re-sync of the same version is a no-op on the files.
    const inode = statSync(f.claude).ino;
    await f.runtime.sync(f.project);
    expect(statSync(f.claude).ino).toBe(inode);
  });

  it("refuses an existing unmanaged file and leaves every target untouched", async () => {
    const f = fixture();
    await f.provider.create(request);
    mkdirSync(dirname(f.codex));
    writeFileSync(f.codex, "my own notes\n");
    await expect(f.runtime.sync(f.project)).rejects.toMatchObject({
      code: "PROJECTION_COLLISION",
    });
    expect(readFileSync(f.codex, "utf8")).toBe("my own notes\n");
    expect(record(f.store, f.codex)).toBeUndefined();
    // The collision is found before any write, so the Claude file is not created either.
    expect(existsSync(f.claude)).toBe(false);
    expect(await states(f.runtime, f.project)).toEqual({
      [f.claude]: "not-synced",
      [f.codex]: "collision",
    });
  });

  it("replaces the file by rename on a new version without exposing partial content", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    await f.runtime.sync(f.project);
    const before = statSync(f.claude).ino;
    await publish(f.provider, created.skillId, v2);
    const observed: string[] = [];
    const projections = new Projections(f.store, (point) => {
      if (point !== "before-swap") return;
      // The complete next version is staged beside the target while readers
      // still see the complete previous version.
      observed.push(readFileSync(f.claude, "utf8"));
      const staged = readdirSync(dirname(f.claude)).filter((name) =>
        name.startsWith(".skillplane-instructions-"),
      );
      expect(staged).toHaveLength(1);
      observed.push(
        readFileSync(join(dirname(f.claude), requireValue(staged[0])), "utf8"),
      );
    });
    const snapshot = await f.provider.retrieve(created.skillId);
    const next = projections.instructions.sync(
      snapshot,
      instructionTargetSchema.parse({ adapter: "claude", artifact: "global-agents" }),
      f.project,
    );
    expect(observed).toEqual([v1, v2]);
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    expect(statSync(f.claude).ino).not.toBe(before);
    expect(next.digest).toBe(sha(v2));
    expect(record(f.store, f.claude)?.version.semanticVersion).toBe("1.1.0");
  });

  it("detects a hand edit, never overwrites it and reports it in doctor", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    await f.runtime.sync(f.project);
    writeFileSync(f.claude, `${v1}\nmy local rule\n`);
    await publish(f.provider, created.skillId, v2);
    await expect(f.runtime.sync(f.project)).rejects.toMatchObject({
      code: "PROJECTION_DIVERGED",
    });
    expect(readFileSync(f.claude, "utf8")).toBe(`${v1}\nmy local rule\n`);
    expect(record(f.store, f.claude)?.digest).toBe(sha(v1));
    expect(await states(f.runtime, f.project)).toEqual({ [f.claude]: "diverged" });
  });

  it("writes a deleted owned file again and reports it missing until then", async () => {
    const f = fixture([{ adapter: "codex", artifact: "global-agents" }]);
    await f.provider.create(request);
    await f.runtime.sync(f.project);
    rmSync(f.codex);
    expect(await states(f.runtime, f.project)).toEqual({ [f.codex]: "missing" });
    await f.runtime.sync(f.project);
    expect(readFileSync(f.codex, "utf8")).toBe(v1);
  });

  it("rolls back a write interrupted before the rename and keeps the previous file", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    await f.runtime.sync(f.project);
    await publish(f.provider, created.skillId, v2);
    const crashing = new Projections(f.store, (point) => {
      if (point === "before-swap") throw new Error("crash");
    });
    const target = instructionTargetSchema.parse({
      adapter: "claude",
      artifact: "global-agents",
    });
    const snapshot = await f.provider.retrieve(created.skillId);
    expect(() => crashing.instructions.sync(snapshot, target, f.project)).toThrow(
      "crash",
    );
    expect(readFileSync(f.claude, "utf8")).toBe(v1);
    expect(f.store.entries("instruction-journal:")).toHaveLength(1);

    expect(new Projections(f.store).recover()).toEqual([]);
    expect(f.store.entries("instruction-journal:")).toHaveLength(0);
    expect(readFileSync(f.claude, "utf8")).toBe(v1);
    expect(record(f.store, f.claude)?.digest).toBe(sha(v1));
    expect(
      readdirSync(dirname(f.claude)).filter((n) =>
        n.startsWith(".skillplane-instructions-"),
      ),
    ).toEqual([]);
    // Re-running reuses the staged generation and completes.
    await f.runtime.sync(f.project);
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
  });

  it("completes a write interrupted after the rename instead of reporting it as a hand edit", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    await f.runtime.sync(f.project);
    await publish(f.provider, created.skillId, v2);
    const crashing = new Projections(f.store, (point) => {
      if (point === "after-swap") throw new Error("crash");
    });
    const target = instructionTargetSchema.parse({
      adapter: "claude",
      artifact: "global-agents",
    });
    const snapshot = await f.provider.retrieve(created.skillId);
    expect(() => crashing.instructions.sync(snapshot, target, f.project)).toThrow(
      "crash",
    );
    // The rename landed but the record commit did not.
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    expect(record(f.store, f.claude)?.digest).toBe(sha(v1));

    const id = InstructionProjections.id(f.claude);
    expect(new Projections(f.store).recover()).toEqual([id]);
    expect(record(f.store, f.claude)?.digest).toBe(sha(v2));
    expect(new Projections(f.store).recover()).toEqual([]);
    expect(await states(f.runtime, f.project)).toEqual({ [f.claude]: "in-sync" });
    const inode = statSync(f.claude).ino;
    await f.runtime.sync(f.project);
    expect(statSync(f.claude).ino).toBe(inode);
  });

  it("leaves the journal of a live writer in another process alone", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    const crashing = new Projections(f.store, (point) => {
      if (point === "before-swap") throw new Error("crash");
    });
    const target = instructionTargetSchema.parse({
      adapter: "claude",
      artifact: "global-agents",
    });
    const snapshot = await f.provider.retrieve(created.skillId);
    expect(() => crashing.instructions.sync(snapshot, target, f.project)).toThrow(
      "crash",
    );
    const [[key, journal]] = f.store.entries<{ pid: number; startedAt: string }>(
      "instruction-journal:",
    ) as [[string, { pid: number; startedAt: string }]];
    // The parent process is alive and is not this process.
    f.store.set(key, { ...journal, pid: process.ppid });
    new Projections(f.store).recover();
    expect(f.store.get(key)).toBeDefined();
    // A journal older than any lock-bounded write is dead even if its PID was reused.
    f.store.set(key, {
      ...journal,
      pid: process.ppid,
      startedAt: new Date(0).toISOString(),
    });
    new Projections(f.store).recover();
    expect(f.store.get(key)).toBeUndefined();
  });

  it("serializes a concurrent sync on the projection lock with one result", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    const target = instructionTargetSchema.parse({
      adapter: "claude",
      artifact: "global-agents",
    });
    const snapshot = await f.provider.retrieve(created.skillId);
    const other = new Projections(f.reopen());
    let competing: InstructionRecord | undefined;
    const first = new Projections(f.store, (point) => {
      // The other process wins the lock between this one's plan and its write.
      if (point === "before-write" && !competing)
        competing = other.instructions.sync(snapshot, target, f.project);
    });
    const result = first.instructions.sync(snapshot, target, f.project);
    expect(result.eventId).toBe(requireValue(competing).eventId);
    expect(readFileSync(f.claude, "utf8")).toBe(v1);
    expect(f.store.entries("instruction-journal:")).toHaveLength(0);
    expect(
      readdirSync(dirname(f.claude)).filter((n) =>
        n.startsWith(".skillplane-instructions-"),
      ),
    ).toEqual([]);

    // A writer whose plan went stale under the lock fails without touching the file.
    await publish(f.provider, created.skillId, v2);
    const planned = await f.provider.retrieve(created.skillId);
    const v3 = `${v2}\nKeep PRs small.\n`;
    await publish(f.provider, created.skillId, v3);
    const newest = await f.provider.retrieve(created.skillId);
    let raced = false;
    const stale = new Projections(f.store, (point) => {
      if (point === "before-write" && !raced) {
        raced = true;
        other.instructions.sync(newest, target, f.project);
      }
    });
    expect(() => stale.instructions.sync(planned, target, f.project)).toThrow(
      "Projection changed",
    );
    expect(readFileSync(f.claude, "utf8")).toBe(v3);
    // Nothing was written, so no journal is left for recover() to act on.
    expect(f.store.entries("instruction-journal:")).toHaveLength(0);
    expect(new Projections(f.store).recover()).toEqual([]);
    expect(record(f.store, f.claude)?.digest).toBe(sha(v3));
    expect(readFileSync(f.claude, "utf8")).toBe(v3);
  });

  it("never claims a file a user edited to the planned bytes while a sync waited", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    await f.runtime.sync(f.project);
    await publish(f.provider, created.skillId, v2);
    const target = instructionTargetSchema.parse({
      adapter: "claude",
      artifact: "global-agents",
    });
    const snapshot = await f.provider.retrieve(created.skillId);
    const editing = new Projections(f.store, (point) => {
      // The user pastes the new text by hand between the plan and the lock.
      if (point === "before-write") writeFileSync(f.claude, v2);
    });
    expect(() => editing.instructions.sync(snapshot, target, f.project)).toThrow(
      "it was not overwritten",
    );
    expect(f.store.entries("instruction-journal:")).toHaveLength(0);
    // A later recovery does not record Skillplane as the writer of those bytes.
    expect(new Projections(f.store).recover()).toEqual([]);
    expect(record(f.store, f.claude)?.digest).toBe(sha(v1));
    expect(await states(f.runtime, f.project)).toEqual({ [f.claude]: "diverged" });
  });

  describe("recovery commits only the file the interrupted write renamed", () => {
    const target = instructionTargetSchema.parse({
      adapter: "claude",
      artifact: "global-agents",
    });
    const crashBeforeSwap = (f: ReturnType<typeof fixture>) =>
      new Projections(f.store, (point) => {
        if (point === "before-swap") throw new Error("crash");
      });
    const temps = (f: ReturnType<typeof fixture>) =>
      readdirSync(dirname(f.claude)).filter((n) =>
        n.startsWith(".skillplane-instructions-"),
      );

    it("never adopts a fresh target the user filled with the planned bytes", async () => {
      const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
      const created = await f.provider.create(request);
      const snapshot = await f.provider.retrieve(created.skillId);
      expect(() =>
        crashBeforeSwap(f).instructions.sync(snapshot, target, f.project),
      ).toThrow("crash");
      expect(existsSync(f.claude)).toBe(false);
      writeFileSync(f.claude, v1);

      const projections = new Projections(f.store);
      expect(projections.recover()).toEqual([]);
      expect(f.store.entries("instruction-journal:")).toHaveLength(0);
      expect(temps(f)).toEqual([]);
      expect(record(f.store, f.claude)).toBeUndefined();
      expect(
        projections.instructions.owners(InstructionProjections.id(f.claude)),
      ).toEqual([]);
      expect(readFileSync(f.claude, "utf8")).toBe(v1);
      await expect(f.runtime.sync(f.project)).rejects.toMatchObject({
        code: "PROJECTION_COLLISION",
      });
      expect(readFileSync(f.claude, "utf8")).toBe(v1);
    });

    it("keeps the previous record when the user pastes the interrupted version", async () => {
      const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
      const created = await f.provider.create(request);
      await f.runtime.sync(f.project);
      await publish(f.provider, created.skillId, v2);
      const snapshot = await f.provider.retrieve(created.skillId);
      expect(() =>
        crashBeforeSwap(f).instructions.sync(snapshot, target, f.project),
      ).toThrow("crash");
      writeFileSync(f.claude, v2);

      expect(new Projections(f.store).recover()).toEqual([]);
      expect(f.store.entries("instruction-journal:")).toHaveLength(0);
      expect(temps(f)).toEqual([]);
      expect(record(f.store, f.claude)?.digest).toBe(sha(v1));
      await expect(f.runtime.sync(f.project)).rejects.toMatchObject({
        code: "PROJECTION_DIVERGED",
      });
      expect(readFileSync(f.claude, "utf8")).toBe(v2);
      expect(await states(f.runtime, f.project)).toEqual({ [f.claude]: "diverged" });
    });

    it("rolls back a renamed file the user edited before recovery", async () => {
      const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
      const created = await f.provider.create(request);
      await f.runtime.sync(f.project);
      await publish(f.provider, created.skillId, v2);
      const snapshot = await f.provider.retrieve(created.skillId);
      const crashing = new Projections(f.store, (point) => {
        if (point === "after-swap") throw new Error("crash");
      });
      expect(() => crashing.instructions.sync(snapshot, target, f.project)).toThrow(
        "crash",
      );
      // The renamed file keeps its inode but no longer holds the written bytes.
      writeFileSync(f.claude, `${v2}\nmy local rule\n`);
      expect(new Projections(f.store).recover()).toEqual([]);
      expect(record(f.store, f.claude)?.digest).toBe(sha(v1));
      expect(readFileSync(f.claude, "utf8")).toBe(`${v2}\nmy local rule\n`);
      expect(await states(f.runtime, f.project)).toEqual({ [f.claude]: "diverged" });
    });
  });

  it("never reads a writer's renamed but uncommitted file as unmanaged", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    const target = instructionTargetSchema.parse({
      adapter: "claude",
      artifact: "global-agents",
    });
    const snapshot = await f.provider.retrieve(created.skillId);
    const otherStore = f.reopen();
    otherStore.db.exec("PRAGMA busy_timeout=50");
    const other = new Projections(otherStore);
    let observed: unknown;
    const writer = new Projections(f.store, (point) => {
      if (point !== "after-swap") return;
      // The file is in place but its record is not committed yet.
      try {
        other.instructions.check(snapshot, target, f.project);
        observed = "checked";
      } catch (error) {
        observed = error;
      }
    });
    writer.instructions.sync(snapshot, target, f.project);
    // The other process waits for the projection lock instead of reporting a collision.
    expect(observed).toMatchObject({ message: expect.stringMatching(/locked/) });
    expect(() => other.instructions.check(snapshot, target, f.project)).not.toThrow();
  });

  it("lets projects share a target for one artifact but not take it for another", async () => {
    const f = fixture([{ adapter: "claude", artifact: "global-agents" }]);
    const created = await f.provider.create(request);
    await f.provider.create({
      ...request,
      slug: "work-agents",
      idempotencyKey: "work",
      instructions: "# Work\n",
    });
    const shared = join(f.root, "shared");
    const rival = join(f.root, "rival");
    mkdirSync(shared);
    mkdirSync(rival);
    const base = f.runtime.project(f.project);
    f.runtime.configure(shared, base);
    f.runtime.configure(rival, {
      ...base,
      instructions: [{ adapter: "claude", artifact: "work-agents" }],
    });
    await f.runtime.sync(f.project);
    await f.runtime.sync(shared);
    // Either project configuring the same artifact may advance it.
    await publish(f.provider, created.skillId, v2);
    await f.runtime.sync(shared);
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    await expect(f.runtime.sync(rival)).rejects.toMatchObject({
      code: "PROJECTION_COLLISION",
    });
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    // doctor applies the same rule and names the artifact in the file.
    const doctor = async (project: string) =>
      ((await f.runtime.doctor(false, project)) as Doctor).instructions;
    expect(await doctor(rival)).toEqual([
      expect.objectContaining({
        path: f.claude,
        artifact: "global-agents",
        configuredArtifact: "work-agents",
        owners: [f.project, shared].sort(),
        state: "collision",
      }),
    ]);
    rmSync(f.claude);
    expect(await states(f.runtime, rival)).toEqual({ [f.claude]: "collision" });
    await f.runtime.sync(shared);
    expect(await doctor(shared)).toEqual([
      expect.not.objectContaining({ configuredArtifact: expect.anything() }),
    ]);
    expect(await states(f.runtime, shared)).toEqual({ [f.claude]: "in-sync" });
    // Once both projects drop the target, its file stays and another artifact may take it.
    for (const project of [f.project, shared]) {
      f.runtime.configure(project, { ...base, instructions: [] });
      await f.runtime.sync(project);
    }
    expect(readFileSync(f.claude, "utf8")).toBe(v2);
    expect(await states(f.runtime, rival)).toEqual({ [f.claude]: "not-synced" });
    await f.runtime.sync(rival);
    expect(readFileSync(f.claude, "utf8")).toBe("# Work\n");
  });

  describe("doctor resolves a configured name to the artifact sync would write", () => {
    // Another project holds the target with the team workspace's agents
    // document; this project's primary has its own agents and work documents.
    async function shadowed() {
      const f = fixture([{ adapter: "claude", artifact: "agents" }]);
      const team = LocalWorkspaceProvider.create(f.store, "Team");
      await team.create({
        ...request,
        slug: "agents",
        idempotencyKey: "team",
        instructions: "# Team\n",
      });
      const own = await f.provider.create({ ...request, slug: "agents" });
      const work = await f.provider.create({
        ...request,
        slug: "work",
        idempotencyKey: "work",
        instructions: "# Work\n",
      });
      const owner = join(f.root, "owner");
      mkdirSync(owner);
      f.runtime.configure(owner, {
        formatVersion: 1,
        primary: team.workspace,
        instructions: [{ adapter: "claude", artifact: "agents" }],
      });
      await f.runtime.sync(owner);
      const base = f.runtime.project(f.project);
      const qualified = (skillId: string) => `${workspaceKey(base.primary)}/${skillId}`;
      return {
        ...f,
        owner,
        qualified,
        own: own.skillId,
        work: work.skillId,
        /** Configures this project to mount the team workspace without a namespace. */
        mount: (context: object) =>
          f.runtime.configure(f.project, {
            ...base,
            mounts: [{ workspace: team.workspace }],
            ...context,
          }),
        doctor: async () =>
          ((await f.runtime.doctor(false, f.project)) as Doctor).instructions,
      };
    }
    async function expectCollision(s: Awaited<ReturnType<typeof shadowed>>) {
      await expect(s.runtime.sync(s.project)).rejects.toMatchObject({
        code: "PROJECTION_COLLISION",
      });
      expect(readFileSync(s.claude, "utf8")).toBe("# Team\n");
      expect(await s.doctor()).toEqual([
        expect.objectContaining({
          path: s.claude,
          artifact: "agents",
          configuredArtifact: "agents",
          owners: [s.owner],
          state: "collision",
        }),
      ]);
    }
    it("reports a collision when the primary shadows the mount's same-name document", async () => {
      const s = await shadowed();
      s.mount({ collisions: "precedence" });
      await expectCollision(s);
    });
    it("reports a collision when a qualified alias takes the mount's name", async () => {
      const s = await shadowed();
      s.mount({
        collisions: "precedence",
        aliases: { [s.qualified(s.own)]: "personal", [s.qualified(s.work)]: "agents" },
      });
      await expectCollision(s);
    });
    it("reports sync's catalog error for an ambiguous name", async () => {
      const s = await shadowed();
      s.mount({ collisions: "error" });
      await expect(s.runtime.sync(s.project)).rejects.toMatchObject({
        code: "SKILL_NAME_COLLISION",
      });
      expect(await s.doctor()).toEqual([
        expect.objectContaining({
          state: "SKILL_NAME_COLLISION",
          fileState: "in-sync",
        }),
      ]);
    });
    it("shares the target when the name resolves to the document in the file", async () => {
      const s = await shadowed();
      s.mount({ aliases: { [s.qualified(s.own)]: "personal" } });
      expect(await s.doctor()).toEqual([
        expect.not.objectContaining({ configuredArtifact: expect.anything() }),
      ]);
      expect(await states(s.runtime, s.project)).toEqual({ [s.claude]: "in-sync" });
      await s.runtime.sync(s.project);
      expect(readFileSync(s.claude, "utf8")).toBe("# Team\n");
      expect(
        s.runtime.projections.instructions.owners(InstructionProjections.id(s.claude)),
      ).toEqual([s.owner, s.project].sort());
    });
  });

  it("projects a generic target and keeps skills and instructions in their own destinations", async () => {
    const f = fixture([
      { adapter: "generic", path: "~/rules/RULES.md", artifact: "global-agents" },
    ]);
    f.runtime.configure(f.project, {
      ...f.runtime.project(f.project),
      targets: [targetSchema.parse({ adapter: "claude", scope: "user" })],
    });
    await f.provider.create(request);
    await f.provider.create({
      ...request,
      kind: "skill",
      slug: "review",
      instructions: "Review carefully.",
      idempotencyKey: "skill",
    });
    const synced = await f.runtime.syncTargets(f.project);
    expect(synced.projections.map((r) => r.name)).toEqual(["review"]);
    expect(synced.instructions.map((r) => r.path)).toEqual([
      join(f.home, "rules", "RULES.md"),
    ]);
    expect(readFileSync(join(f.home, "rules", "RULES.md"), "utf8")).toBe(v1);
    expect(readdirSync(join(f.home, ".claude", "skills"))).toEqual(["review"]);
    expect(existsSync(f.claude)).toBe(false);
  });

  it("names the missing artifact and duplicate destinations before writing", async () => {
    const f = fixture([{ adapter: "claude", artifact: "absent" }]);
    await f.provider.create(request);
    await expect(f.runtime.sync(f.project)).rejects.toMatchObject({
      code: "INSTRUCTIONS_NOT_FOUND",
    });
    f.runtime.configure(f.project, {
      ...f.runtime.project(f.project),
      instructions: [
        { adapter: "claude", artifact: "global-agents" },
        { adapter: "generic", path: "~/.claude/CLAUDE.md", artifact: "global-agents" },
      ],
    });
    await expect(f.runtime.sync(f.project)).rejects.toThrow(
      "Duplicate instructions destination",
    );
    expect(existsSync(f.claude)).toBe(false);
  });
});
