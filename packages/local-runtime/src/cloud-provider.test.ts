import { requireValue } from "./contracts.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CloudWorkspaceProvider,
  LocalWorkspaceProvider,
  LocalStore,
  RuntimeError,
  type WorkspaceRef,
  type CreateRequest,
  type CloudTransport,
} from "./index.js";
const stores: LocalStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const request: CreateRequest = {
  slug: "example",
  name: "Example",
  description: "Original immutable description",
  instructions: "Read this document.",
  tags: [],
  assets: [{ path: "references/detail.txt", content: "Details" }],
  visibility: "private",
  idempotencyKey: "create-1",
};
function fixture() {
  const store = new LocalStore(
    realpathSync(mkdtempSync(join(tmpdir(), "cloud-contract-"))),
  );
  stores.push(store);
  const local = LocalWorkspaceProvider.create(store, "Backing fixture");
  const workspace: Extract<
    WorkspaceRef,
    {
      provider: "cloud";
    }
  > = {
    provider: "cloud",
    profile: "work",
    endpoint: "https://mcp.example.com/mcp",
    id: local.workspace.id,
  };
  const calls: string[] = [];
  const transport: CloudTransport = {
    async call(name, args) {
      calls.push(name);
      const skillId =
        (
          args.skill as
            | {
                id: string;
              }
            | undefined
        )?.id ?? String(args.skillId ?? "");
      if (name === "skill_create") {
        const input = { ...args };
        delete input.workspace;
        delete input.caller;
        const result = await local.create(input as CreateRequest);
        const snapshot = await local.retrieve(result.skillId);
        const now = snapshot.version.createdAt;
        return {
          requestId: "request",
          skill: {
            id: result.skillId,
            workspaceId: workspace.id,
            workspaceSlug: "work",
            ...snapshot.bundle.skill,
            visibility: "private",
            currentVersion: { id: result.versionId, semanticVersion: "1.0.0" },
            archivedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          version: {},
        };
      }
      if (name === "skills_list")
        return {
          requestId: "request",
          workspace: { id: workspace.id, slug: "work", name: "Work", kind: "personal" },
          skills: await Promise.all(
            (await local.list()).map(async (s) => {
              const v = (await local.retrieve(s.id)).version;
              return {
                id: s.id,
                workspaceId: workspace.id,
                workspaceSlug: "work",
                slug: s.slug,
                name: s.name,
                summary: s.description,
                tags: [],
                visibility: "private",
                currentVersion: { id: v.id, semanticVersion: v.semanticVersion },
                archivedAt: null,
                updatedAt: v.createdAt,
              };
            }),
          ),
          nextCursor: null,
        };
      const selected = args.version as
        | {
            versionId?: string;
          }
        | undefined;
      const snapshot = await local.retrieve(skillId, selected?.versionId);
      const version = snapshot.version;
      const bundle = snapshot.bundle;
      if (name === "skill_versions_list")
        return {
          requestId: "request",
          skillId,
          versions: (await local.versions(skillId)).map((v) => ({
            ...v,
            revision: 1,
            source: "human",
            baseVersionId: null,
            proposedBump: null,
            changeSummary: "Initial version",
            learningSummary: null,
            authorType: "user",
            publishedAt: v.createdAt,
          })),
          nextCursor: null,
        };
      if (name === "skill_retrieve")
        return {
          requestId: "request",
          skill: {
            ...snapshot.skill,
            description: "Mutable catalog description",
            workspaceId: workspace.id,
            workspaceSlug: "work",
            tags: [],
            visibility: "private",
          },
          version: {
            ...version,
            revision: 1,
            byteSize: bundle.bytes.length,
            manifest: bundle.manifest,
            publishedAt: version.createdAt,
          },
          instructions: new TextDecoder().decode(bundle.files.get("SKILL.md")),
          files: bundle.manifest.files,
          context: null,
        };
      if (name === "skill_asset_retrieve") {
        const path = String(args.path);
        const entry = requireValue(bundle.manifest.files.find((f) => f.path === path));
        return {
          requestId: "request",
          skillId,
          versionId: version.id,
          path,
          mediaType: entry.mediaType,
          byteSize: entry.byteSize,
          sha256: entry.sha256,
          bundleDigest: version.digest,
          delivery: "text",
          text: new TextDecoder().decode(bundle.files.get(path)),
        };
      }
      if (name === "skill_usage_report")
        return {
          requestId: "request",
          acceptedId: (
            args.event as {
              id: string;
            }
          ).id,
          confidence: "reported",
          coverage:
            "Client-reported event; disconnected embedded use is unobservable. Success is not inferred.",
        };
      throw new Error(`Unexpected call ${name}`);
    },
    async download() {
      throw new Error("No download expected");
    },
  };
  return {
    local,
    workspace,
    transport,
    calls,
    cloud: new CloudWorkspaceProvider(workspace, transport),
  };
}
describe("cloud provider transport contract", () => {
  it("uses immutable metadata and verifies every file instead of mutable catalog metadata", async () => {
    const { local, cloud, calls } = fixture();
    const initial = await local.create(request);
    const localSnapshot = await local.retrieve(initial.skillId);
    const cloudSnapshot = await cloud.retrieve(initial.skillId);
    expect(cloudSnapshot.bundle.digest).toBe(localSnapshot.bundle.digest);
    expect(cloudSnapshot.bundle.skill.description).toBe(request.description);
    expect(calls.filter((name) => name === "skill_asset_retrieve")).toHaveLength(2);
    expect(requireValue((await cloud.list())[0]).id).toBe(initial.skillId);
    expect(requireValue((await cloud.versions(initial.skillId))[0]).id).toBe(
      initial.versionId,
    );
  });
  it("rejects a result from another account/workspace and corrupt assets", async () => {
    const { local, workspace, transport } = fixture();
    const initial = await local.create(request);
    const wrong = new CloudWorkspaceProvider(
      { ...workspace, id: "workspace:other" },
      transport,
    );
    await expect(wrong.retrieve(initial.skillId)).rejects.toThrow("WORKSPACE_MISMATCH");
    const corrupt = new CloudWorkspaceProvider(workspace, {
      ...transport,
      async call(name, args) {
        const result = await transport.call(name, args);
        return name === "skill_asset_retrieve"
          ? { ...(result as object), text: "tampered" }
          : result;
      },
    });
    await expect(corrupt.retrieve(initial.skillId)).rejects.toThrow("DIGEST_MISMATCH");
  });
  it("sends idempotent usage receipts only for the exact qualified cloud workspace", async () => {
    const { cloud, local, workspace } = fixture();
    const initial = await local.create(request);
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: "skill_invoked_observed" as const,
      workspace: (await import("./contracts.js")).workspaceKey(workspace),
      skillId: initial.skillId,
      versionId: initial.versionId,
      projectionId: null,
      installationId: randomUUID(),
      agent: "codex",
      model: "unknown",
      modelTrust: "caller-declared" as const,
      sessionId: null,
      delivery: "live-cli" as const,
      freshness: "verified" as const,
      confidence: "observed" as const,
      evidence: null,
    };
    expect(await cloud.reportUsage(event)).toBe(event.id);
    await expect(cloud.reportUsage({ ...event, workspace: "other" })).rejects.toThrow(
      "USAGE_SCOPE_INVALID",
    );
    await expect(
      cloud.reportUsage({ ...event, type: "skill_success_verified" }),
    ).rejects.toThrow("USAGE_SCOPE_INVALID");
  });
  it("never follows a foreign authenticated asset download", async () => {
    const { McpTransport } = await import("./cloud-provider.js");
    const transport = new McpTransport(
      "https://mcp.example.com/mcp",
      async () => "secret",
    );
    await expect(
      transport.download("https://evil.example/asset", 100),
    ).rejects.toBeInstanceOf(RuntimeError);
  });
});
