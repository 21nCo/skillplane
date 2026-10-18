import { requireValue } from "./contracts.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { bundleEntrypoint } from "@skillplane/storage";
import {
  CloudWorkspaceProvider,
  LocalWorkspaceProvider,
  LocalStore,
  RuntimeError,
  type WorkspaceRef,
  type AmendRequest,
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
interface CandidateRow {
  reviewId: string;
  state: string;
  base: string | null;
  digest: string;
  expectedUpdatedAt: string;
  reason: string | null;
}
const policyDecision = {
  outcome: "review_required",
  reason: "policy_requires_review",
  matchedRule: null,
};
function candidateResult(row: CandidateRow, semanticVersion: string | null) {
  const published = row.state === "published";
  return {
    review: {
      id: row.reviewId,
      status: published ? "approved" : "pending",
      decisionReason: published ? row.reason : null,
      requestedBy: { actorType: "user", agent: null, model: null },
      policyDecision,
      reviewedAt: published ? row.expectedUpdatedAt : null,
      createdAt: row.expectedUpdatedAt,
      updatedAt: row.expectedUpdatedAt,
    },
    candidate: {
      id: row.reviewId,
      revision: 2,
      semanticVersion,
      state: row.state,
      source: "agent_amendment",
      digest: row.digest,
      baseVersionId: row.base,
      proposedBump: "patch",
      changeSummary: "Amended",
      createdAt: row.expectedUpdatedAt,
      publishedAt: published ? row.expectedUpdatedAt : null,
    },
  };
}
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
  const listArgs: Record<string, unknown>[] = [];
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
            slug: snapshot.bundle.skill.slug,
            name: snapshot.bundle.skill.name,
            description: snapshot.bundle.skill.description,
            tags: snapshot.bundle.skill.tags,
            visibility: "private",
            currentVersion: { id: result.versionId, semanticVersion: "1.0.0" },
            archivedAt: null,
            createdAt: now,
            updatedAt: now,
          },
          version: {
            id: result.versionId,
            revision: 1,
            semanticVersion: "1.0.0",
            state: "published",
            source: "human",
            digest: snapshot.bundle.digest,
            baseVersionId: null,
            proposedBump: null,
            changeSummary: "Created",
            createdAt: now,
            publishedAt: now,
          },
        };
      }
      if (name === "skills_list") {
        listArgs.push(args);
        return {
          requestId: "request",
          workspace: { id: workspace.id, slug: "work", name: "Work", kind: "personal" },
          skills: await Promise.all(
            // The server lists only skills unless the caller selects a kind.
            (await local.list())
              .filter((s) => s.kind === (args.kind ?? "skill"))
              .map(async (s) => {
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
                  ...(s.kind === "instructions" ? { kind: s.kind } : {}),
                  currentVersion: { id: v.id, semanticVersion: v.semanticVersion },
                  archivedAt: null,
                  updatedAt: v.createdAt,
                };
              }),
          ),
          nextCursor: null,
        };
      }
      if (name === "skill_amend") {
        const input = { ...args };
        delete input.caller;
        const result = await local.amend(input as AmendRequest);
        const row = requireValue(
          ((await local.candidates(skillId)) as CandidateRow[]).find(
            (c) => c.reviewId === result.versionId,
          ),
        );
        return {
          requestId: "request",
          skillId,
          baseVersionId: input.baseVersionId,
          candidate: {
            id: result.versionId,
            revision: 2,
            state: "candidate",
            semanticVersion: null,
            digest: row.digest,
            proposedBump: input.proposedBump,
            createdAt: row.expectedUpdatedAt,
            publishedAt: null,
          },
          review: { id: result.versionId, status: "pending" },
          policyDecision,
          autoPublished: false,
        };
      }
      if (name === "skill_candidates_list")
        return {
          requestId: "request",
          skillId,
          candidates: ((await local.candidates(skillId)) as CandidateRow[]).map((c) =>
            candidateResult(c, null),
          ),
          nextCursor: null,
        };
      if (name === "skill_candidate_approve") {
        const published = await local.decide(
          skillId,
          String(args.reviewId),
          String(args.expectedUpdatedAt),
          true,
          String(args.reason),
          String(args.idempotencyKey),
        );
        return {
          requestId: "request",
          skillId,
          result: candidateResult(
            {
              reviewId: published.id,
              state: published.state,
              base: null,
              digest: published.digest,
              expectedUpdatedAt: published.createdAt,
              reason: String(args.reason),
            },
            published.semanticVersion,
          ),
        };
      }
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
          instructions: new TextDecoder().decode(
            bundle.files.get(bundleEntrypoint(bundle.skill)),
          ),
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
    listArgs,
    cloud: new CloudWorkspaceProvider(workspace, transport),
  };
}
describe("cloud provider transport contract", () => {
  it("rebuilds an instructions document from its AGENTS.md entrypoint", async () => {
    const { local, cloud, calls, listArgs } = fixture();
    const created = await local.create({
      ...request,
      kind: "instructions",
      assets: [],
      instructions: "# Agents\n\nRun the tests.\n",
    });
    const snapshot = await cloud.retrieve(created.skillId);
    expect(snapshot.skill.kind).toBe("instructions");
    expect(snapshot.bundle.digest).toBe(
      (await local.retrieve(created.skillId)).bundle.digest,
    );
    expect(calls.filter((name) => name === "skill_asset_retrieve")).toHaveLength(1);
    // Local projection lists skills only; SKI-24 owns instructions projection.
    expect(await cloud.list()).toEqual([]);
    expect(listArgs.every((args) => args.kind === undefined)).toBe(true);
  });
  it("reviews instructions documents through ID-only lifecycle operations", async () => {
    const { cloud, listArgs, workspace } = fixture();
    const document = "# Agents\n\nRun the tests.\n";
    const created = await cloud.create({
      ...request,
      kind: "instructions",
      assets: [],
      instructions: document,
    });
    const amended = await cloud.amend({
      skillId: created.skillId,
      baseVersionId: created.versionId,
      proposedBump: "minor",
      idempotencyKey: "amend-instructions",
      changes: [
        {
          operation: "replace",
          path: "AGENTS.md",
          expectedSha256: createHash("sha256").update(document).digest("hex"),
          content: `${document}\nKeep PRs small.\n`,
        },
      ],
      learning: {
        summary: "Ask for small PRs",
        observation: "Large PRs stalled review",
        rationale: "Smaller changes review faster",
        confidence: "high",
        evidence: [],
        evidenceUnavailableReason: "Editorial update",
        validation: [],
        validationNotRunReason: "No executable change",
      },
    });
    expect((await cloud.versions(created.skillId)).map((v) => v.id)).toContain(
      created.versionId,
    );
    const [candidate] = (await cloud.candidates(created.skillId)) as {
      review: { id: string; updatedAt: string };
    }[];
    expect(candidate?.review.id).toBe(amended.versionId);
    const decision = (await cloud.decide(
      created.skillId,
      amended.versionId,
      candidate?.review.updatedAt ?? "",
      true,
      "Clearer guidance",
      "approve-instructions",
    )) as { result: { candidate: { state: string; semanticVersion: string } } };
    expect(decision.result.candidate).toMatchObject({
      state: "published",
      semanticVersion: "1.1.0",
    });
    const snapshot = await cloud.retrieve(created.skillId);
    expect(snapshot.skill.kind).toBe("instructions");
    expect(snapshot.version.id).toBe(amended.versionId);
    // Membership checks the exact workspace across both kinds.
    expect(listArgs.map((args) => args.kind)).toContain("instructions");
    await expect(cloud.candidates("skill:missing")).rejects.toThrow("SKILL_NOT_FOUND");
    // Projection, sync and usage membership stay skills-only.
    expect(await cloud.list()).toEqual([]);
    await expect(
      cloud.reportUsage({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "skill_invoked_observed",
        workspace: (await import("./contracts.js")).workspaceKey(workspace),
        skillId: created.skillId,
        versionId: amended.versionId,
        projectionId: null,
        installationId: randomUUID(),
        agent: "codex",
        model: "unknown",
        modelTrust: "caller-declared",
        sessionId: null,
        delivery: "live-cli",
        freshness: "verified",
        confidence: "observed",
        evidence: null,
      }),
    ).rejects.toThrow("SKILL_NOT_FOUND");
  });
  it("keeps membership errors for servers that predate artifact kinds", async () => {
    const { local, workspace, transport } = fixture();
    const created = await local.create({ ...request, assets: [] });
    // McpTransport's error for a base server whose strict skills_list input
    // schema rejects the kind argument (MCPFN_INVALID_ARGUMENTS in text content).
    const rejection = (property: string) =>
      new RuntimeError(
        "CLOUD_REQUEST_REJECTED",
        JSON.stringify([
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: {
                code: "MCPFN_INVALID_ARGUMENTS",
                message: "Invalid arguments",
                details: {
                  lifecycleStage: "input-validation",
                  issues: [
                    {
                      path: "/",
                      instancePath: "/",
                      schemaPath: "#/additionalProperties",
                      keyword: "additionalProperties",
                      message: `must not have unknown property "${property}"`,
                      rejectedProperty: property,
                    },
                  ],
                },
              },
            }),
          },
        ]),
      );
    let probes = 0;
    const preKind = new CloudWorkspaceProvider(workspace, {
      ...transport,
      async call(name, args) {
        if (name === "skills_list" && "kind" in args) {
          probes += 1;
          throw rejection("kind");
        }
        return transport.call(name, args);
      },
    });
    const base = await local.retrieve(created.skillId);
    const amended = await local.amend({
      skillId: created.skillId,
      baseVersionId: created.versionId,
      proposedBump: "patch",
      idempotencyKey: "amend-pre-kind",
      changes: [
        {
          operation: "replace",
          path: "SKILL.md",
          expectedSha256: createHash("sha256")
            .update(requireValue(base.bundle.files.get("SKILL.md")))
            .digest("hex"),
          content: "Read this document twice.",
        },
      ],
      learning: {
        summary: "Read twice",
        observation: "One read missed details",
        rationale: "A second read catches them",
        confidence: "high",
        evidence: [],
        evidenceUnavailableReason: "Editorial update",
        validation: [],
        validationNotRunReason: "No executable change",
      },
    });
    expect((await preKind.versions(created.skillId)).map((v) => v.id)).toContain(
      created.versionId,
    );
    const [candidate] = (await preKind.candidates(created.skillId)) as {
      review: { id: string; updatedAt: string };
    }[];
    expect(candidate?.review.id).toBe(amended.versionId);
    const decision = (await preKind.decide(
      created.skillId,
      amended.versionId,
      candidate?.review.updatedAt ?? "",
      true,
      "Clearer",
      "approve-pre-kind",
    )) as { result: { candidate: { state: string } } };
    expect(decision.result.candidate.state).toBe("published");
    // A skill is found on the skills page, so no kind probe is sent for it.
    expect(probes).toBe(0);
    await expect(preKind.versions("skill:missing")).rejects.toThrow("SKILL_NOT_FOUND");
    await expect(preKind.candidates("skill:missing")).rejects.toThrow(
      "SKILL_NOT_FOUND",
    );
    await expect(
      preKind.decide(
        "skill:missing",
        "version:missing",
        "",
        true,
        "No",
        "decide-missing",
      ),
    ).rejects.toThrow("SKILL_NOT_FOUND");
    // The server's lack of kinds is learned once.
    expect(probes).toBe(1);
    // Any other rejection still reaches the caller.
    const rejecting = new CloudWorkspaceProvider(workspace, {
      ...transport,
      async call(name, args) {
        if (name === "skills_list" && "kind" in args) throw rejection("limit");
        return transport.call(name, args);
      },
    });
    await expect(rejecting.versions("skill:missing")).rejects.toMatchObject({
      code: "CLOUD_REQUEST_REJECTED",
    });
  });
  it("creates through the shared immutable bundle contract", async () => {
    const { cloud } = fixture();
    const created = await cloud.create(request);
    expect(created.skillId).toBeTruthy();
    expect(
      (await cloud.retrieve(created.skillId, created.versionId)).bundle.skill.name,
    ).toBe(request.name);
  });
  it("uses immutable metadata and verifies every file instead of mutable catalog metadata", async () => {
    const { local, cloud, calls } = fixture();
    const initial = await local.create(request);
    const localSnapshot = await local.retrieve(initial.skillId);
    const cloudSnapshot = await cloud.retrieve(initial.skillId);
    expect(cloudSnapshot.bundle.digest).toBe(localSnapshot.bundle.digest);
    expect(cloudSnapshot.bundle.skill.description).toBe(request.description);
    expect(cloudSnapshot.skill.description).toBe(request.description);
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
          ? {
              ...(result as object),
              text: "x".repeat(String((result as { text: string }).text).length),
            }
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
