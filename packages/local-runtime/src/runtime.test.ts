import { requireValue } from "./contracts.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  LocalStore,
  LocalWorkspaceProvider,
  Runtime,
  RuntimeError,
  Projections,
  Profiles,
  projectSchema,
  targetSchema,
  workspaceKey,
  type CreateRequest,
  type AmendRequest,
  type WorkspaceProvider,
} from "./index.js";
import { hash, inventory } from "./files.js";
import { trustExpands } from "./trust.js";
const stores: LocalStore[] = [];
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-test-")));
  const store = new LocalStore(join(root, "state"));
  stores.push(store);
  const runtime = new Runtime(store);
  const project = join(root, "project");
  mkdirSync(project);
  const context = runtime.setup(project, "Personal", [
    targetSchema.parse({ adapter: "codex" }),
  ]);
  const provider = new LocalWorkspaceProvider(store, context.primary.id);
  return { root, store, runtime, project, context, provider };
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const create: CreateRequest = {
  slug: "review",
  name: "Review",
  description: "Review changes carefully",
  tags: [],
  visibility: "private",
  instructions: "Read the changes and explain problems.",
  assets: [],
  idempotencyKey: "create-1",
};
const learning = {
  summary: "Improve clarity",
  observation: "The wording needed more detail",
  rationale: "Explain the expected result",
  confidence: "high" as const,
  evidence: [],
  evidenceUnavailableReason: "Editorial update",
  validation: [],
  validationNotRunReason: "No executable change",
  sourceContextId: null,
  tags: [],
  externalReferences: [],
  extra: {},
};
async function amend(
  provider: LocalWorkspaceProvider,
  initial: {
    skillId: string;
    versionId: string;
  },
  text = "Read changes carefully and explain every problem.",
) {
  const base = await provider.retrieve(initial.skillId, initial.versionId);
  const request: AmendRequest = {
    skillId: initial.skillId,
    baseVersionId: initial.versionId,
    idempotencyKey: randomUUID(),
    proposedBump: "patch",
    changes: [
      {
        operation: "replace",
        path: "SKILL.md",
        expectedSha256: hash(requireValue(base.bundle.files.get("SKILL.md"))),
        content: text,
      },
    ],
    learning,
  };
  const candidate = await provider.amend(request);
  const rows = await provider.candidates(initial.skillId);
  const row = requireValue(rows.find((r) => r.reviewId === candidate.versionId));
  await provider.decide(
    initial.skillId,
    candidate.versionId,
    String(row.expectedUpdatedAt),
    true,
    "Reviewed content",
    randomUUID(),
  );
  return candidate;
}
describe("offline authority and shared immutable semantics", () => {
  it("initializes offline, publishes creation, persists exact content and replays keys", async () => {
    const { runtime, project, provider } = fixture();
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("offline"));
    try {
      const initial = await provider.create(create);
      expect(await provider.create(create)).toEqual(initial);
      await expect(
        provider.create({ ...create, instructions: "changed" }),
      ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
      const snapshot = await provider.retrieve(initial.skillId);
      expect(snapshot.version.semanticVersion).toBe("1.0.0");
      expect(snapshot.version.state).toBe("published");
      expect(runtime.setup(project)).toEqual(runtime.project(project));
      expect(network).not.toHaveBeenCalled();
    } finally {
      network.mockRestore();
    }
  });
  it("checks exact base, file digests, rationale and review races", async () => {
    const { provider } = fixture();
    const initial = await provider.create(create);
    const base = await provider.retrieve(initial.skillId);
    const request: AmendRequest = {
      ...initial,
      baseVersionId: initial.versionId,
      idempotencyKey: "amend-1",
      proposedBump: "patch",
      changes: [
        {
          operation: "replace",
          path: "SKILL.md",
          expectedSha256: hash(requireValue(base.bundle.files.get("SKILL.md"))),
          content: "New wording.",
        },
      ],
      learning,
    };
    delete (request as unknown as Record<string, unknown>).versionId;
    const candidate = await provider.amend(request);
    expect(await provider.amend(request)).toEqual(candidate);
    expect((await provider.retrieve(initial.skillId)).version.id).toBe(
      initial.versionId,
    );
    const row = requireValue((await provider.candidates(initial.skillId))[0]);
    await expect(
      provider.decide(
        initial.skillId,
        candidate.versionId,
        "stale",
        true,
        "Reviewed",
        "approve-1",
      ),
    ).rejects.toThrow("REVIEW_CONFLICT");
    await provider.decide(
      initial.skillId,
      candidate.versionId,
      String(row.expectedUpdatedAt),
      true,
      "Reviewed",
      "approve-1",
    );
    expect((await provider.retrieve(initial.skillId)).version.semanticVersion).toBe(
      "1.0.1",
    );
    await expect(
      provider.amend({ ...request, idempotencyKey: "amend-2" }),
    ).rejects.toThrow("SKILL_VERSION_CONFLICT");
    expect(
      (await provider.retrieve(initial.skillId, initial.versionId)).bundle.digest,
    ).toBe(base.bundle.digest);
  });
  it("rejects traversal, case collisions, digest corruption and cross-workspace writes", async () => {
    const { provider, store } = fixture();
    await expect(
      provider.create({ ...create, assets: [{ path: "../escape", content: "x" }] }),
    ).rejects.toThrow();
    await expect(
      provider.create({
        ...create,
        assets: [
          { path: "assets/X.txt", content: "x" },
          { path: "assets/x.txt", content: "x" },
        ],
      }),
    ).rejects.toThrow();
    const initial = await provider.create(create);
    const snapshot = await provider.retrieve(initial.skillId);
    const other = LocalWorkspaceProvider.create(store, "Other");
    await expect(other.retrieve(initial.skillId)).rejects.toThrow("SKILL_NOT_FOUND");
    writeFileSync(store.bundlePath(snapshot.bundle.digest), "corruption");
    await expect(provider.retrieve(initial.skillId)).rejects.toThrow("DIGEST_MISMATCH");
  });
  it("exports and imports exact bundle bytes without changing source authority", async () => {
    const { runtime, provider, root, store } = fixture();
    const initial = await provider.create(create);
    const snapshot = await provider.retrieve(initial.skillId);
    const file = join(root, "bundle.zip");
    runtime.exportBundle(snapshot, file);
    const other = LocalWorkspaceProvider.create(store, "Destination");
    const result = (await runtime.importBundle(
      projectSchema.parse({ formatVersion: 1, primary: other.workspace }),
      readFileSync(file),
      "import-1",
    )) as {
      skillId: string;
    };
    expect((await other.retrieve(result.skillId)).bundle.digest).toBe(
      snapshot.bundle.digest,
    );
    expect(await provider.list()).toHaveLength(1);
    expect(() => runtime.exportBundle(snapshot, file)).toThrow("EXPORT_EXISTS");
  });
});
describe("routing and credentials", () => {
  it("requires explicit primary, handles ordered collisions and namespaces, protects mounts", async () => {
    const { runtime, context, provider, store } = fixture();
    const initial = await provider.create(create);
    const other = LocalWorkspaceProvider.create(store, "Other");
    await other.create(create);
    const mounted = projectSchema.parse({
      ...context,
      mounts: [{ workspace: other.workspace }],
    });
    await expect(runtime.catalog(mounted)).rejects.toThrow("Resolve review");
    expect(
      await runtime.catalog({ ...mounted, collisions: "precedence" }),
    ).toHaveLength(1);
    expect(
      await runtime.catalog({
        ...mounted,
        mounts: [{ workspace: other.workspace, namespace: "work" }],
      }),
    ).toHaveLength(2);
    const result = await runtime.create(mounted, {
      ...create,
      slug: "new-skill",
      idempotencyKey: "create-2",
    });
    expect(result).toBeTruthy();
    expect(await other.list()).toHaveLength(1);
    await expect(
      runtime.amend({ ...context, primary: other.workspace }, {
        skillId: initial.skillId,
        baseVersionId: initial.versionId,
      } as AmendRequest),
    ).rejects.toThrow();
    expect(projectSchema.safeParse({ formatVersion: 1, mounts: [] }).success).toBe(
      false,
    );
    expect(projectSchema.safeParse({ ...context, token: "secret" }).success).toBe(
      false,
    );
  });
  it("keeps account tokens in a protected secret service and qualifies identical slugs", async () => {
    const { store, project } = fixture();
    const secrets = new Map<string, string>();
    const profiles = new Profiles(store, {
      async get(k) {
        return requireValue(secrets.get(k));
      },
      async set(k, v) {
        secrets.set(k, v);
      },
      async delete(k) {
        secrets.delete(k);
      },
    });
    const personal = await profiles.add(
      "personal",
      "https://example.com/mcp",
      "account-1",
      "token-personal",
    );
    const work = await profiles.add(
      "work",
      "https://example.com/mcp",
      "account-2",
      "token-work",
    );
    expect(personal.credentialRef).not.toBe(work.credentialRef);
    expect(JSON.stringify(store.entries("profile:"))).not.toContain("token-");
    expect(readFileSync(join(project, "skillplane.json"), "utf8")).not.toContain(
      "token-",
    );
    await expect(
      profiles.add("work", "https://example.com/mcp", "account-1", "token"),
    ).rejects.toMatchObject({ code: "PROFILE_IDENTITY_CONFLICT" });
    await expect(
      profiles.add("unsafe", "http://remote.example/mcp", "account", "token"),
    ).rejects.toThrow("ENDPOINT_INVALID");
    expect(
      workspaceKey({
        provider: "cloud",
        profile: "work",
        endpoint: work.endpoint,
        id: "workspace:1",
      }),
    ).not.toBe(
      workspaceKey({
        provider: "cloud",
        profile: "personal",
        endpoint: personal.endpoint,
        id: "workspace:1",
      }),
    );
  });
});
describe("projection ownership, policies and interruption recovery", () => {
  it.each(["codex", "claude", "generic"] as const)(
    "renders %s self-contained projections with exact provenance, no resolver copies",
    async (adapter) => {
      const { runtime, provider, project } = fixture();
      await provider.create(create);
      runtime.configure(project, {
        ...runtime.project(project),
        targets: [
          { adapter, ...(adapter === "generic" ? { directory: "exports" } : {}) },
        ],
      });
      const first = requireValue((await runtime.sync(project))[0]);
      const link = readlinkSync(first.path);
      const manifest = JSON.parse(
        readFileSync(join(first.path, "projection.json"), "utf8"),
      );
      expect(manifest.digest).toBe(first.digest);
      expect(manifest.version.id).toBe(first.version.id);
      expect(manifest.workspace).toEqual(first.workspace);
      const launcher = readFileSync(join(first.path, "SKILL.md"), "utf8");
      expect(launcher).toContain("exactly ONE");
      expect(launcher).toContain("snapshot/SKILL.md");
      expect(launcher.includes("!`skillplane")).toBe(adapter === "claude");
      expect(
        Object.keys(inventory(first.generation)).some((p) => p.endsWith(".js")),
      ).toBe(false);
      expect((await runtime.sync(project))[0]).toEqual(first);
      expect(readlinkSync(first.path)).toBe(link);
      const resolution = await runtime.resolve(first.id);
      expect(resolution.useEmbedded).toBe(true);
      expect(resolution).not.toHaveProperty("instructions");
      expect(runtime.usage.report().counts["skill_projected/projection/observed"]).toBe(
        1,
      );
    },
  );
  it("rolls back to a verified prior version and pins it", async () => {
    const { runtime, provider, project } = fixture();
    const initial = await provider.create(create);
    const first = requireValue((await runtime.sync(project))[0]);
    await amend(provider, initial);
    await runtime.sync(project);
    const restored = await runtime.projections.rollback(first.id);
    expect(restored.version.id).toBe(initial.versionId);
    expect((await runtime.resolve(first.id)).version.id).toBe(initial.versionId);
    expect(restored.target.policy.mode).toBe("pinned");
  });
  it("does not adopt or overwrite user files or edited owned files", async () => {
    const { runtime, provider, project } = fixture();
    await provider.create(create);
    const target = join(project, ".agents/skills/review");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "User managed");
    await expect(runtime.sync(project)).rejects.toThrow("Unowned target");
    expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("User managed");
    const other = fixture();
    await other.provider.create(create);
    const record = requireValue((await other.runtime.sync(other.project))[0]);
    writeFileSync(join(record.path, "SKILL.md"), "User edited");
    await expect(other.runtime.sync(other.project)).rejects.toThrow(
      "PROJECTION_DIVERGED",
    );
    expect(() => other.runtime.projections.uninstall(record.id)).toThrow(
      "PROJECTION_DIVERGED",
    );
  });
  it.each(["before-write", "before-swap", "after-swap"] as const)(
    "recovers interruption at %s without mixed generations",
    async (point) => {
      const { runtime, provider, project, store } = fixture();
      const initial = await provider.create(create);
      const old = requireValue((await runtime.sync(project))[0]);
      const updated = await amend(provider, initial);
      const snapshot = await provider.retrieve(updated.skillId);
      const faulty = new Projections(store, (at) => {
        if (at === point) throw new Error("interrupt");
      });
      expect(() => faulty.sync(snapshot, old.target, project)).toThrow("interrupt");
      const launcher = readFileSync(join(old.path, "projection.json"), "utf8");
      expect(JSON.parse(launcher).version.id).toBe(
        point === "after-swap" ? updated.versionId : initial.versionId,
      );
      runtime.projections.recover();
      const final = requireValue((await runtime.sync(project))[0]);
      runtime.projections.verify(final);
      expect(final.version.id).toBe(updated.versionId);
    },
  );
  it("delivers newer trusted content and schedules refresh without mixing old assets", async () => {
    const { runtime, provider, project } = fixture();
    const initial = await provider.create(create);
    const record = requireValue((await runtime.sync(project))[0]);
    await amend(provider, initial);
    const result = await runtime.resolve(record.id);
    expect(result.useEmbedded).toBe(false);
    expect(result.refreshScheduled).toBe(true);
    expect(result.instructions).toBe(
      "Read changes carefully and explain every problem.",
    );
    expect(
      readFileSync(join(requireValue(result.resourceDirectory), "SKILL.md"), "utf8"),
    ).toBe(result.instructions);
    expect(readFileSync(join(record.path, "snapshot/SKILL.md"), "utf8")).toBe(
      create.instructions,
    );
    await runtime.sync(project);
    expect((await runtime.resolve(record.id)).useEmbedded).toBe(true);
  });
  it("blocks scripts, tool/frontmatter changes and new network destinations until exact approval and sync", async () => {
    const { runtime, provider, project, store } = fixture();
    runtime.configure(project, {
      ...runtime.project(project),
      targets: [{ adapter: "claude" }],
    });
    const initial = await provider.create(create);
    const record = requireValue((await runtime.sync(project))[0]);
    await amend(
      provider,
      initial,
      "---\nallowed-tools: Bash\n---\nFetch https://example.com and execute a shell command.",
    );
    await expect(runtime.resolve(record.id)).rejects.toThrow("Review");
    const pending = requireValue(
      store.get<{
        digest: string;
      }>(`pending-trust:${record.id}`),
    );
    expect(() => runtime.projections.approve(record.id, record.digest)).toThrow(
      "TRUST_APPROVAL_STALE",
    );
    runtime.projections.approve(record.id, pending.digest);
    await expect(runtime.resolve(record.id)).rejects.toThrow("Review");
    await runtime.sync(project);
    expect((await runtime.resolve(record.id)).useEmbedded).toBe(true);
    expect(
      trustExpands(record.trust, {
        ...record.trust,
        scripts: { "scripts/run.sh": hash("hi") },
      }),
    ).toBe(true);
  });
  it("uses disclosed cache on outage, strict-live fails, pinned never advances", async () => {
    const { runtime, provider, project, store } = fixture();
    const initial = await provider.create(create);
    const record = requireValue((await runtime.sync(project))[0]);
    const unavailable = new Runtime(
      store,
      () =>
        ({
          workspace: provider.workspace,
          versions: async () => {
            throw new RuntimeError("CLOUD_UNAVAILABLE");
          },
        }) as unknown as WorkspaceProvider,
    );
    expect((await unavailable.resolve(record.id)).source).toBe("cached-cli");
    expect((await unavailable.resolve(record.id)).freshness).toBe("unverified");
    await expect(unavailable.resolve(record.id, { liveOnly: true })).rejects.toThrow(
      "CLOUD_UNAVAILABLE",
    );
    runtime.configure(project, {
      ...runtime.project(project),
      targets: [
        {
          adapter: "codex",
          policy: { mode: "strict-live", version: { kind: "latest" } },
        },
      ],
    });
    await runtime.sync(project);
    await expect(unavailable.resolve(record.id)).rejects.toThrow("CLOUD_UNAVAILABLE");
    await expect(unavailable.resolve(record.id, { cacheOnly: true })).rejects.toThrow(
      "LIVE_REQUIRED",
    );
    runtime.configure(project, {
      ...runtime.project(project),
      targets: [
        {
          adapter: "codex",
          policy: {
            mode: "pinned",
            version: { kind: "pinned", id: initial.versionId },
          },
        },
      ],
    });
    await runtime.sync(project);
    await amend(provider, initial);
    expect((await runtime.resolve(record.id)).version.id).toBe(initial.versionId);
    expect((await unavailable.resolve(record.id)).version.id).toBe(initial.versionId);
  });
  it("rejects symlink escapes and uninstalls only the owned entry", async () => {
    const { runtime, project, provider, root } = fixture();
    await provider.create(create);
    symlinkSync(root, join(project, ".agents"));
    await expect(runtime.sync(project)).rejects.toThrow("SYMLINK_FORBIDDEN");
    const other = fixture();
    const initial = await other.provider.create(create);
    const record = requireValue((await other.runtime.sync(other.project))[0]);
    const neighbor = join(other.project, ".agents/skills/manual");
    mkdirSync(neighbor);
    writeFileSync(join(neighbor, "SKILL.md"), "manual");
    other.runtime.projections.uninstall(record.id);
    expect(existsSync(record.path)).toBe(false);
    expect(existsSync(neighbor)).toBe(true);
    expect((await other.provider.retrieve(initial.skillId)).version.id).toBe(
      initial.versionId,
    );
  });
});
describe("analytics boundaries and replay", () => {
  it("keeps events local by default, distinguishes install/invocation/completion, rejects verified claims", async () => {
    const { runtime, provider, project, store } = fixture();
    await provider.create(create);
    const projection = requireValue((await runtime.sync(project))[0]);
    expect(runtime.usage.report().counts).not.toHaveProperty(
      "skill_invoked_observed/live-cli/observed",
    );
    await runtime.resolve(projection.id);
    const events = store.db
      .prepare("SELECT payload FROM usage")
      .all()
      .map((r) => JSON.parse(String(r.payload)));
    const event = {
      ...events[0],
      id: randomUUID(),
      type: "skill_completion_reported",
      confidence: "reported",
    };
    runtime.usage.record(event);
    runtime.usage.record(event);
    expect(
      runtime.usage.report().counts["skill_completion_reported/projection/reported"],
    ).toBe(1);
    expect(() =>
      runtime.usage.record({
        ...event,
        type: "skill_success_verified",
        confidence: "verified",
        evidence: "claimed",
      }),
    ).toThrow("INDEPENDENT_VERIFIER_REQUIRED");
    const send = vi.fn(
      async (
        es: {
          id: string;
        }[],
      ) => es.map((e) => e.id),
    );
    await expect(runtime.usage.upload(send)).rejects.toThrow(
      "ANALYTICS_CONSENT_REQUIRED",
    );
    expect(send).not.toHaveBeenCalled();
    store.set("analytics:consent", true);
    const count = await runtime.usage.upload(send);
    expect(count).toBe(4);
    expect(await runtime.usage.upload(send)).toBe(0);
    expect(runtime.usage.report().coverage).toContain("not complete usage totals");
  });
});
