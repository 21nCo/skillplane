import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudWorkspaceProvider } from "../../../packages/local-runtime/src/cloud-provider.js";
import { workspaceKey } from "../../../packages/local-runtime/src/contracts.js";
import { hash } from "../../../packages/local-runtime/src/files.js";
import {
  parseStructured,
  startMcpTestEnvironment,
  TEST_CALLER,
  type ConnectedMcpClient,
  type McpTestEnvironment,
} from "../support/mcp-test-environment.js";

let environment: McpTestEnvironment;
let connection: ConnectedMcpClient;
let provider: CloudWorkspaceProvider;
beforeAll(async () => {
  environment = await startMcpTestEnvironment("local-provider-contract");
  connection = await environment.connect(
    await environment.issueOAuthToken(
      "skills:read skills:write skills:amend skills:publish",
    ),
  );
  provider = new CloudWorkspaceProvider(
    {
      provider: "cloud",
      profile: "test",
      endpoint: "https://mcp.skillplane.dev/mcp",
      id: environment.owner.workspaceId,
    },
    {
      async call(name, args) {
        return parseStructured(
          await connection.client.callTool({ name, arguments: args }),
        );
      },
      async download() {
        throw new Error("Unexpected large asset download");
      },
    },
    TEST_CALLER,
  );
}, 60_000);
afterAll(async () => {
  await connection?.client.close();
  await environment?.close();
}, 30_000);

describe("MCP-only cloud provider with real domain services", () => {
  it("creates, retrieves, amends, publishes and retains an exact immutable base without projection files", async () => {
    const request = {
      slug: "client-contract",
      name: "Client contract",
      description: "Provider contract",
      instructions: "Read the document.",
      tags: [],
      visibility: "private" as const,
      assets: [],
      idempotencyKey: "create-client-contract",
    };
    const initial = await provider.create(request);
    expect(await provider.create(request)).toEqual(initial);
    const snapshot = await provider.retrieve(initial.skillId);
    expect(snapshot.version.semanticVersion).toBe("1.0.0");
    const amended = await provider.amend({
      skillId: initial.skillId,
      baseVersionId: initial.versionId,
      idempotencyKey: "amend-client-contract",
      proposedBump: "patch",
      changes: [
        {
          operation: "replace",
          path: "SKILL.md",
          expectedSha256: hash(snapshot.bundle.files.get("SKILL.md") ?? ""),
          content: "Read the entire document.",
        },
      ],
      learning: {
        summary: "Clarify completeness",
        observation: "The scope was unclear",
        rationale: "Make the instruction explicit",
        confidence: "high",
        evidence: [],
        evidenceUnavailableReason: "Editorial update",
        validation: [],
        validationNotRunReason: "No executable change",
        sourceContextId: null,
        tags: [],
        externalReferences: [],
        extra: {},
      },
    });
    expect((await provider.retrieve(initial.skillId)).version.id).toBe(
      initial.versionId,
    );
    const candidates = (await provider.candidates(initial.skillId)) as {
      review: { id: string; updatedAt: string };
      candidate: { id: string };
    }[];
    const candidate = candidates.find((c) => c.candidate.id === amended.versionId);
    if (!candidate) throw new Error("Candidate missing");
    await provider.decide(
      initial.skillId,
      candidate.review.id,
      candidate.review.updatedAt,
      true,
      "Reviewed content",
      "approve-client-contract",
    );
    expect((await provider.retrieve(initial.skillId)).version.semanticVersion).toBe(
      "1.0.1",
    );
    expect(
      (await provider.retrieve(initial.skillId, initial.versionId)).bundle.digest,
    ).toBe(snapshot.bundle.digest);
  });
  it("deduplicates uploaded events and preserves reported confidence", async () => {
    const event = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type: "skill_completion_reported" as const,
      workspace: workspaceKey(provider.workspace),
      skillId: environment.skill.skill.id,
      versionId: environment.skill.version.id,
      projectionId: null,
      installationId: crypto.randomUUID(),
      agent: "test",
      model: "declared",
      modelTrust: "caller-declared" as const,
      sessionId: null,
      delivery: "cached-cli" as const,
      freshness: "unverified" as const,
      confidence: "reported" as const,
      evidence: null,
    };
    expect(await provider.reportUsage(event)).toBe(event.id);
    expect(await provider.reportUsage(event)).toBe(event.id);
    const rows = await environment.services.skillService.pool.query(
      "SELECT metadata FROM audit_events WHERE workspace_id=$1 AND metadata->'usage'->>'id'=$2",
      [environment.owner.workspaceId, event.id],
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].metadata.usage.confidence).toBe("reported");
  });
  it("rejects another workspace's private content", async () => {
    const outsider = await environment.connect(environment.outsiderServiceToken);
    try {
      const result = await outsider.client.callTool({
        name: "skill_retrieve",
        arguments: {
          skill: { id: environment.privateSkill.skill.id },
          caller: TEST_CALLER,
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await outsider.client.close();
    }
  });
});
