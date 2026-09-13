import { createSkillBundle } from "@skillplane/domain";
import { Projections, assertProjectionSupported } from "./projections.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  unlinkSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalStore } from "./store.js";
import { Runtime } from "./runtime.js";
import { LocalWorkspaceProvider } from "./local-provider.js";
import { Profiles } from "./profiles.js";
import { McpTransport } from "./cloud-provider.js";
import { UsageQueue, type UsageEvent } from "./analytics.js";
import {
  requireValue,
  declaredCaller,
  RuntimeError,
  selectVersion,
  targetSchema,
  workspaceKey,
  type WorkspaceProvider,
  type VersionInfo,
} from "./contracts.js";
import { trustEnvelope, trustExpands } from "./trust.js";
import { skillFrontmatter } from "./frontmatter.js";
import type { CanonicalBundle } from "@skillplane/storage";
const resources: { root: string; store: LocalStore }[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-remediation-")));
  const store = new LocalStore(join(root, "state"));
  resources.push({ root, store });
  const project = join(root, "project");
  mkdirSync(project);
  const runtime = new Runtime(store);
  const context = runtime.setup(project, "Tests", [
    targetSchema.parse({ adapter: "codex" }),
  ]);
  return {
    root,
    store,
    project,
    runtime,
    provider: new LocalWorkspaceProvider(store, context.primary.id),
  };
}
async function sharedFixture() {
  const f = fixture();
  await f.provider.create(create);
  const target = targetSchema.parse({
    adapter: "codex",
    scope: "user",
    directory: join(f.root, "shared"),
  });
  f.runtime.configure(f.project, {
    ...f.runtime.project(f.project),
    targets: [target],
  });
  const other = join(f.root, "other");
  mkdirSync(other);
  f.runtime.configure(other, f.runtime.project(f.project));
  const record = requireValue((await f.runtime.sync(f.project))[0]);
  await f.runtime.sync(other);
  return { ...f, other, target, record };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, store } of resources.splice(0)) {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
const create = {
  name: "Review",
  slug: "review",
  description: "Review",
  tags: [],
  visibility: "private" as const,
  instructions: "Read the changes.",
  assets: [],
  idempotencyKey: "create-test",
};
function event(workspace = "cloud:test"): UsageEvent {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "skill_resolved",
    workspace,
    skillId: "skill:test",
    versionId: "version:test",
    projectionId: null,
    installationId: randomUUID(),
    agent: "test",
    model: "test",
    modelTrust: "caller-declared",
    sessionId: null,
    delivery: "cached-cli",
    freshness: "unverified",
    confidence: "observed",
    evidence: null,
  };
}
describe("review regressions", () => {
  it("derives the hosted client identity from the published package", async () => {
    const packageJson = (await import("../package.json", { with: { type: "json" } }))
      .default;
    expect(declaredCaller()).toMatchObject({
      clientName: "skillplane-cli",
      clientVersion: packageJson.version,
    });
  });

  it("preserves native composition metadata in the shared cloud builder and refuses incomplete local projections", async () => {
    const composition = { dependencies: [], verify: false, blocking: false };
    const bundle = await createSkillBundle({ ...create, composition });
    expect(bundle.skill).toMatchObject({
      formatVersion: 2,
      dependencies: [],
      entrypoints: { execute: "SKILL.md" },
    });
    expect(() => assertProjectionSupported(bundle)).toThrow("native MCP skill_resolve");
    const { provider } = fixture();
    await expect(provider.create({ ...create, composition })).rejects.toMatchObject({
      code: "COMPOSITION_RESOLUTION_REQUIRED",
    });
  });
  it.each(["fetch", "stream"])(
    "maps %s outages while downloading to resilient fallback errors",
    async (kind) => {
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        if (kind === "fetch") throw new TypeError("offline");
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("stream offline"));
            },
          }),
        );
      });
      await expect(
        new McpTransport("https://example.test/mcp", async () => "token").download(
          "https://example.test/asset",
          100,
        ),
      ).rejects.toMatchObject({ code: "CLOUD_UNAVAILABLE" });
    },
  );
  it("preserves size and origin policy failures", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("too large"));
    const transport = new McpTransport("https://example.test/mcp", async () => "token");
    await expect(transport.download("https://example.test/a", 1)).rejects.toMatchObject(
      { code: "ASSET_TOO_LARGE" },
    );
    await expect(transport.download("https://other.test/a", 100)).rejects.toMatchObject(
      { code: "DOWNLOAD_ORIGIN_INVALID" },
    );
  });
  it("normalizes profile URLs and translates malformed input", async () => {
    const { store } = fixture();
    const secrets = new Map<string, string>();
    const profiles = new Profiles(store, {
      get: async (k) => requireValue(secrets.get(k)),
      set: async (k, v) => {
        secrets.set(k, v);
      },
      delete: async (k) => {
        secrets.delete(k);
      },
    });
    await profiles.add("test", "https://EXAMPLE.test:443", "account", "token");
    expect(profiles.get("test", "https://example.test").endpoint).toBe(
      "https://example.test/",
    );
    expect(() => profiles.get("test", "bad")).toThrow("ENDPOINT_INVALID");
  });
  it("does not upload local events, and quarantines a rejected event without blocking later acknowledgments", async () => {
    const { store } = fixture();
    const queue = new UsageQueue(store);
    store.set("analytics:consent", true);
    const local = event("local:test"),
      bad = event(),
      good = event();
    [local, bad, good].forEach((e) => queue.record(e));
    const send = vi.fn(async (events: UsageEvent[]) => {
      if (requireValue(events[0]).id === bad.id)
        throw new RuntimeError("SKILL_VERSION_NOT_FOUND");
      return events.map((e) => e.id);
    });
    await expect(queue.upload(send)).rejects.toThrow("CLOUD_WORKSPACE_REQUIRED");
    expect(await queue.upload(send, "cloud:test")).toBe(1);
    expect(send.mock.calls.flatMap((c) => c[0]).some((e) => e.id === local.id)).toBe(
      false,
    );
    expect(queue.report()).toMatchObject({ pending: 1, quarantined: 1 });
  });
  it("keeps valid rows usable after a corrupt durable payload", async () => {
    const { store } = fixture();
    const queue = new UsageQueue(store);
    store.set("analytics:consent", true);
    store.db
      .prepare("INSERT INTO usage(id,payload) VALUES(?,?)")
      .run(randomUUID(), "not-json");
    queue.record(event());
    expect(() => queue.report()).not.toThrow();
    expect(await queue.upload(async (es) => es.map((e) => e.id), "cloud:test")).toBe(1);
    expect(queue.report().quarantined).toBe(1);
  });
  it("orders release versions above prereleases regardless of publication date", () => {
    const version = (id: string, semanticVersion: string, createdAt: string) =>
      ({ id, semanticVersion, createdAt, state: "published" }) as VersionInfo;
    expect(
      selectVersion(
        [
          version("rc", "1.0.0-rc.1", "2026-09-13"),
          version("release", "1.0.0", "2026-09-12"),
        ],
        { mode: "resilient", version: { kind: "latest" } },
      ).id,
    ).toBe("release");
  });
  it("detects uppercase network destinations and PowerShell modules", () => {
    const bundle = (body: string, script = "one") =>
      ({
        files: new Map([
          ["SKILL.md", Buffer.from(body)],
          ["assets/tool.psm1", Buffer.from(script)],
        ]),
      }) as CanonicalBundle;
    const before = trustEnvelope(bundle("Read."));
    const after = trustEnvelope(
      bundle("HTTPS://example.test and WSS://socket.test", "two"),
    );
    expect(after.network).toEqual(["https://example.test", "wss://socket.test"]);
    expect(trustExpands(before, after)).toBe(true);
    expect(after.scripts["assets/tool.psm1"]).toBeTruthy();
    expect(() => skillFrontmatter("---\nname: &x hello\nalias: *x\n---\nText")).toThrow(
      "FRONTMATTER_INVALID",
    );
  });
  it("skips a broken newer cache and keeps the intact embedded version", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const [record] = await runtime.sync(project);
    const digest = `sha256:${"a".repeat(64)}`;
    store.set(
      `cache:${workspaceKey(requireValue(record).workspace)}:${requireValue(record).skill.id}:missing`,
      {
        workspace: requireValue(record).workspace,
        skill: requireValue(record).skill,
        version: {
          ...requireValue(record).version,
          id: "missing",
          semanticVersion: "9.0.0",
          digest,
        },
        digest,
      },
    );
    vi.spyOn(runtime, "provider").mockReturnValue({
      versions: async () => {
        throw new RuntimeError("CLOUD_UNAVAILABLE");
      },
    } as unknown as WorkspaceProvider);
    const resolved = await runtime.resolve(requireValue(record).id);
    expect(resolved.source).toBe("cached-cli");
    expect(resolved.version.id).toBe(requireValue(record).version.id);
  });
  it("rejects duplicate targets before creating a projection", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const context = runtime.project(project);
    context.targets.push(requireValue(context.targets[0]));
    runtime.configure(project, context);
    await expect(runtime.sync(project)).rejects.toThrow("Duplicate target destination");
    expect(store.entries("projection:")).toHaveLength(0);
  });
  it("removes excluded projections and recovers an interrupted uninstall", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const [record] = await runtime.sync(project);
    expect(record).toBeTruthy();
    expect(
      readFileSync(join(requireValue(record).generation, "SKILL.md"), "utf8"),
    ).toContain(`--home '${store.root}'`);
    store.set(`uninstall-journal:${requireValue(record).id}`, record);
    unlinkSync(requireValue(record).path);
    expect(runtime.projections.recover()).toContain(requireValue(record).id);
    expect(store.get(`projection:${requireValue(record).id}`)).toBeUndefined();
    await runtime.sync(project);
    const context = runtime.project(project);
    requireValue(context.targets[0]).skills = [];
    runtime.configure(project, context);
    expect(await runtime.sync(project)).toHaveLength(0);
    expect(existsSync(requireValue(record).path)).toBe(false);
  });
  it("replaces an owned destination when the configured workspace changes", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const old = requireValue((await runtime.sync(project))[0]);
    const next = LocalWorkspaceProvider.create(store, "Replacement");
    await next.create({ ...create, instructions: "Replacement instructions." });
    runtime.configure(project, {
      ...runtime.project(project),
      primary: next.workspace,
    });
    const current = requireValue((await runtime.sync(project))[0]);
    expect(current.id).not.toBe(old.id);
    expect(current.path).toBe(old.path);
    runtime.projections.verify(current);
    expect(store.get(`projection:${old.id}`)).toBeUndefined();
    expect(readFileSync(join(current.generation, "snapshot", "SKILL.md"), "utf8")).toBe(
      "Replacement instructions.",
    );
  });
  it("recovers ownership after an interrupted source replacement", async () => {
    const { runtime, provider, project, store } = fixture();
    const created = await provider.create(create);
    const old = requireValue((await runtime.sync(project))[0]);
    const next = LocalWorkspaceProvider.create(store, "Replacement");
    const replacement = await next.create({ ...create, instructions: "Replacement" });
    expect(replacement.skillId).not.toBe(created.skillId);
    const snapshot = await next.retrieve(replacement.skillId, replacement.versionId);
    const projections = new Projections(store, (point) => {
      if (point === "after-swap") throw new Error("simulated crash");
    });
    expect(() => projections.sync(snapshot, old.target, project, old.name)).toThrow(
      "simulated crash",
    );
    const recovered = runtime.projections.recover();
    expect(recovered).toHaveLength(1);
    const current = runtime.projections.get(requireValue(recovered[0]));
    runtime.projections.verify(current);
    expect(runtime.projections.owners(current)).toEqual([project]);
    expect(store.get(`projection:${old.id}`)).toBeUndefined();
  });
  it("keeps shared user projections until the final project releases them", async () => {
    const { runtime, provider, project, root } = fixture();
    await provider.create(create);
    const target = targetSchema.parse({
      adapter: "codex",
      scope: "user",
      directory: join(root, "shared"),
    });
    runtime.configure(project, { ...runtime.project(project), targets: [target] });
    const other = join(root, "other");
    mkdirSync(other);
    runtime.configure(other, runtime.project(project));
    const first = requireValue((await runtime.sync(project))[0]);
    expect(requireValue((await runtime.sync(other))[0]).id).toBe(first.id);
    runtime.configure(project, { ...runtime.project(project), targets: [] });
    await runtime.sync(project);
    runtime.projections.verify(first);
    expect(await runtime.sync(other)).toHaveLength(1);
    runtime.configure(other, { ...runtime.project(other), targets: [] });
    await runtime.sync(other);
    expect(existsSync(first.path)).toBe(false);
  });
  it("refuses to replace a destination still referenced by another project", async () => {
    const { runtime, provider, project, root, store } = fixture();
    await provider.create(create);
    const target = targetSchema.parse({
      adapter: "codex",
      scope: "user",
      directory: join(root, "shared"),
    });
    runtime.configure(project, { ...runtime.project(project), targets: [target] });
    const other = join(root, "other");
    mkdirSync(other);
    runtime.configure(other, runtime.project(project));
    const old = requireValue((await runtime.sync(project))[0]);
    await runtime.sync(other);
    const next = LocalWorkspaceProvider.create(store, "Replacement");
    await next.create(create);
    runtime.configure(project, {
      ...runtime.project(project),
      primary: next.workspace,
    });
    await expect(runtime.sync(project)).rejects.toThrow(
      "Destination is owned by another project",
    );
    runtime.projections.verify(old);
  });
  it("recreates a missing owned link and can remove a missing excluded link", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const old = requireValue((await runtime.sync(project))[0]);
    unlinkSync(old.path);
    const repaired = requireValue((await runtime.sync(project))[0]);
    expect(repaired.id).toBe(old.id);
    runtime.projections.verify(repaired);
    unlinkSync(repaired.path);
    runtime.configure(project, { ...runtime.project(project), targets: [] });
    await runtime.sync(project);
    expect(store.get(`projection:${old.id}`)).toBeUndefined();
  });
  it("continues to reject an existing divergent link during repair and uninstall", async () => {
    const { runtime, provider, project, root } = fixture();
    await provider.create(create);
    const old = requireValue((await runtime.sync(project))[0]);
    unlinkSync(old.path);
    symlinkSync(root, old.path, "dir");
    await expect(runtime.sync(project)).rejects.toThrow("PROJECTION_DIVERGED");
    expect(() => runtime.projections.uninstall(old.id)).toThrow("PROJECTION_DIVERGED");
  });
  it("shares equivalent destinations across selection filters and directory spellings", async () => {
    const { runtime, project, other, target, record } = await sharedFixture();
    runtime.configure(other, {
      ...runtime.project(other),
      targets: [{ ...target, skills: ["review"], directory: "../shared" }],
    });
    const shared = requireValue((await runtime.sync(other))[0]);
    expect(shared.generation).toBe(record.generation);
    expect(runtime.projections.owners(shared).sort()).toEqual([project, other].sort());
    runtime.configure(other, {
      ...runtime.project(other),
      targets: [{ ...target, skills: [] }],
    });
    expect(await runtime.sync(other)).toEqual([]);
    expect(runtime.projections.owners(record)).toEqual([project]);
    runtime.projections.verify(record);
  });
  it("rejects conflicting shared versions and policies but repairs the same missing link", async () => {
    const { runtime, provider, project, other, target, record } = await sharedFixture();
    const snapshot = await provider.retrieve(record.skill.id);
    expect(() =>
      runtime.projections.sync(
        {
          ...snapshot,
          version: { ...snapshot.version, id: "another", semanticVersion: "1.0.1" },
        },
        target,
        other,
      ),
    ).toThrow("Destination is owned by another project");
    const pinned = targetSchema.parse({
      ...target,
      policy: { mode: "pinned", version: { kind: "pinned", id: snapshot.version.id } },
    });
    expect(() => runtime.projections.sync(snapshot, pinned, project)).toThrow(
      "Destination is owned by another project",
    );
    expect(() =>
      runtime.projections.sync(snapshot, { ...target, adapter: "claude" }, other),
    ).toThrow("Destination is owned by another project");
    unlinkSync(record.path);
    const repaired = runtime.projections.sync(snapshot, target, other);
    runtime.projections.verify(repaired);
    expect(runtime.projections.owners(repaired).sort()).toEqual(
      [project, other].sort(),
    );
  });
  it("rejects explicit shared uninstall and clears owners after the final removal", async () => {
    const { runtime, project, other, record, store } = await sharedFixture();
    expect(() => runtime.projections.uninstall(record.id)).toThrow(
      "Remove this target",
    );
    runtime.projections.verify(record);
    runtime.projections.uninstall(record.id, project);
    expect(runtime.projections.owners(record)).toEqual([other]);
    runtime.projections.uninstall(record.id);
    expect(runtime.projections.owners(record)).toEqual([]);
    expect(runtime.projections.projectIds(other)).toEqual([]);
    expect(store.get(`projection:${record.id}`)).toBeUndefined();
    const installed = requireValue((await runtime.sync(project))[0]);
    expect(runtime.projections.owners(installed)).toEqual([project]);
  });
  it("backfills every legacy record before incremental owner registrations", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    await provider.create({ ...create, slug: "second", idempotencyKey: "second" });
    const records = await runtime.sync(project);
    const first = requireValue(records[0]),
      second = requireValue(records[1]);
    store.db.exec("DELETE FROM projection_owner");
    store.delete("projection-owners:migrated");
    store.set(`project-projections:${project}`, [first.id]);
    const projections = new Projections(store);
    expect(projections.owners(second)).toEqual([project]);
    const next = LocalWorkspaceProvider.create(store, "Next");
    const created = await next.create(create);
    const replacement = projections.sync(
      await next.retrieve(created.skillId),
      second.target,
      project,
      second.name,
    );
    projections.verify(replacement);
    expect(projections.projectIds(project).sort()).toEqual(
      [first.id, replacement.id].sort(),
    );
    expect(new Projections(store).owners(replacement)).toEqual([project]);
  });
  it("migration does not resurrect a released historical installer or ghost IDs", async () => {
    const { runtime, project, other, record, store } = await sharedFixture();
    runtime.projections.uninstall(record.id, project);
    store.db.exec("DELETE FROM projection_owner");
    store.delete("projection-owners:migrated");
    store.set(`project-projections:${project}`, ["deleted-id"]);
    store.set(`project-projections:${other}`, [record.id]);
    const projections = new Projections(store);
    expect(projections.owners(record)).toEqual([other]);
    expect(projections.projectIds(project)).toEqual([]);
  });
  it("does not scan ownership JSON for each projection during a no-op batch", async () => {
    const { runtime, provider, project, store } = fixture();
    for (let i = 0; i < 12; i++)
      await provider.create({
        ...create,
        slug: `skill-${i}`,
        idempotencyKey: `skill-${i}`,
      });
    await runtime.sync(project);
    const entries = vi.spyOn(store, "entries");
    expect(await runtime.sync(project)).toHaveLength(12);
    expect(
      entries.mock.calls.filter(([prefix]) => prefix === "project-projections:"),
    ).toHaveLength(0);
  });
  it("holds the SQLite writer lock across uninstall verification and unlink", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const record = requireValue((await runtime.sync(project))[0]);
    const second = new LocalStore(store.root);
    second.db.exec("PRAGMA busy_timeout=1");
    let checked = false;
    const projections = new Projections(store, (point) => {
      if (point === "before-unlink") {
        expect(() =>
          second.transaction(() => second.set("concurrent-swap", true)),
        ).toThrow(/locked/);
        checked = true;
      }
    });
    try {
      projections.uninstall(record.id);
      expect(checked).toBe(true);
      second.transaction(() => second.set("after-uninstall", true));
      expect(existsSync(record.path)).toBe(false);
      expect(projections.owners(record)).toEqual([]);
    } finally {
      second.close();
    }
  });
  it("a stale uninstall journal cannot remove a newer generation", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const old = requireValue((await runtime.sync(project))[0]);
    unlinkSync(old.path);
    const current = requireValue((await runtime.sync(project))[0]);
    store.set(`uninstall-journal:${old.id}`, old);
    runtime.projections.recover();
    runtime.projections.verify(current);
    expect(runtime.projections.owners(current)).toEqual([project]);
  });

  it("rollback respects current ownership after the historical installer leaves", async () => {
    const { runtime, provider, project, root } = fixture();
    const created = await provider.create(create);
    const snapshot = await provider.retrieve(created.skillId);
    const target = targetSchema.parse({
      adapter: "codex",
      scope: "user",
      directory: join(root, "shared"),
    });
    const old = runtime.projections.sync(snapshot, target, project);
    const bundle = await createSkillBundle({
      ...create,
      instructions: "Second version",
    });
    const next = {
      ...snapshot,
      bundle,
      version: {
        ...snapshot.version,
        id: "next",
        semanticVersion: "1.0.1",
        digest: bundle.digest,
      },
    };
    runtime.projections.sync(next, target, project);
    const other = join(root, "other");
    mkdirSync(other);
    runtime.projections.sync(next, target, other);
    await expect(runtime.projections.rollback(old.id)).rejects.toThrow(
      "Rollback requires one owning project",
    );
    runtime.projections.uninstall(old.id, project);
    const rolled = await runtime.projections.rollback(old.id);
    expect(rolled.digest).toBe(snapshot.bundle.digest);
    expect(runtime.projections.owners(rolled)).toEqual([other]);
  });
  it("hashes unchanged content once outside the SQLite writer lock", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const record = requireValue((await runtime.sync(project))[0]);
    const other = new LocalStore(store.root);
    other.db.exec("PRAGMA busy_timeout=1");
    const verify = runtime.projections.verify.bind(runtime.projections);
    const calls = vi
      .spyOn(runtime.projections, "verify")
      .mockImplementation((value) => {
        other.transaction(() => other.set("hash-reader-can-write", true));
        verify(value);
      });
    try {
      expect(requireValue((await runtime.sync(project))[0]).generation).toBe(
        record.generation,
      );
      expect(calls).toHaveBeenCalledOnce();
    } finally {
      other.close();
    }
  });
  it("rejects a link changed after hashing but before the no-op transaction", async () => {
    const { runtime, provider, project, root, store } = fixture();
    await provider.create(create);
    const record = requireValue((await runtime.sync(project))[0]);
    const snapshot = await provider.retrieve(record.skill.id);
    const transaction = store.transaction.bind(store);
    vi.spyOn(store, "transaction").mockImplementationOnce((fn) => {
      unlinkSync(record.path);
      symlinkSync(root, record.path, "dir");
      return transaction(fn);
    });
    expect(() => runtime.projections.sync(snapshot, record.target, project)).toThrow(
      "PROJECTION_DIVERGED",
    );
  });
});
