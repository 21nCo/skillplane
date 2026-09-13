import { createSkillBundle } from "@skillplane/domain";
import { assertProjectionSupported } from "./projections.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  mkdirSync,
  unlinkSync,
  existsSync,
  readFileSync,
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
});
