import type {
  SkillAmendOutput,
  SkillAssetRetrieveOutput,
  SkillCandidateDecisionOutput,
  SkillCandidatesListOutput,
  SkillCreateOutput,
  SkillRetrieveOutput,
  SkillsListOutput,
  SkillsSearchOutput,
} from "@skillplane/mcp-schema";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseStructured,
  parseToolError,
  startMcpTestEnvironment,
  TEST_CALLER,
  type ConnectedMcpClient,
  type McpTestEnvironment,
} from "../support/mcp-test-environment.js";
import { PostgresMcpAuditWriter, type McpAuditRecord } from "../../src/audit.js";

let environment: McpTestEnvironment;
let oauth: ConnectedMcpClient;
const auditRecords: McpAuditRecord[] = [];

beforeAll(async () => {
  environment = await startMcpTestEnvironment("instructions", {
    // Capture what reaches the regional writer, which counts agent skill use.
    createAuditWriter: (services) => {
      const writer = new PostgresMcpAuditWriter(services.database.pool);
      return {
        async record(event) {
          auditRecords.push(event);
          await writer.record(event);
        },
        async recordBatch(events) {
          auditRecords.push(...events);
          await writer.recordBatch(events);
        },
      };
    },
  });
  oauth = await environment.connect(
    await environment.issueOAuthToken(
      "skills:read skills:write skills:amend skills:publish contexts:read",
    ),
  );
}, 60_000);

afterAll(async () => {
  await environment.close();
}, 30_000);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const learning = {
  summary: "Tighten repository review instructions",
  observation: "Agents skipped the repository test command.",
  rationale: "The instructions document must name the required command.",
  confidence: "high",
  evidence: [
    {
      kind: "integration",
      reference: TEST_CALLER.runId,
      description: "The instructions lifecycle was exercised through MCP.",
    },
  ],
  validation: [
    {
      kind: "integration",
      status: "passed",
      description: "Kind, revision and digest were read back.",
    },
  ],
} as const;

describe("MCP instructions artifacts", () => {
  it("creates, amends, reviews and publishes instructions that never resolve as skills", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const slug = `repo-agents-${suffix}`;
    const document = "# Repository agents\n\nRun pnpm test before handing off.\n";
    const created = parseStructured<SkillCreateOutput>(
      await oauth.client.callTool({
        name: "skill_create",
        arguments: {
          workspace: { id: environment.owner.workspaceId },
          kind: "instructions",
          slug,
          name: "Repository agents",
          description: "Shared AGENTS.md guidance",
          visibility: "workspace",
          instructions: document,
          idempotencyKey: `instructions-create-${suffix}`,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(created).toMatchObject({
      skill: { slug, kind: "instructions", visibility: "workspace" },
      version: { revision: 1, semanticVersion: "1.0.0", state: "published" },
    });

    const publicCreate = await oauth.client.callTool({
      name: "skill_create",
      arguments: {
        workspace: { id: environment.owner.workspaceId },
        kind: "instructions",
        slug: `public-agents-${suffix}`,
        name: "Public agents",
        visibility: "public",
        instructions: document,
        idempotencyKey: `instructions-public-${suffix}`,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(publicCreate).error.code).toBe("VALIDATION_FAILED");

    const retrieved = parseStructured<SkillRetrieveOutput>(
      await oauth.client.callTool({
        name: "skill_retrieve",
        arguments: { skill: { id: created.skill.id }, caller: TEST_CALLER },
      }),
    );
    expect(retrieved.skill.kind).toBe("instructions");
    expect(retrieved.instructions).toBe(document);
    expect(retrieved.version).toMatchObject({
      revision: 1,
      digest: created.version.digest,
    });
    expect(retrieved.files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "skill.json",
    ]);
    expect(retrieved.composition).toBeUndefined();
    // Agent skill-use metrics count skills only, like the public skill totals.
    const retrieveAudit = auditRecords.filter(
      (event) => event.tool === "skill_retrieve" && event.skillId === created.skill.id,
    );
    expect(retrieveAudit).toEqual([
      expect.objectContaining({ outcome: "success", countMetric: false }),
    ]);
    parseStructured<SkillRetrieveOutput>(
      await oauth.client.callTool({
        name: "skill_retrieve",
        arguments: { skill: { id: environment.skill.skill.id }, caller: TEST_CALLER },
      }),
    );
    const skillAudit = auditRecords.find(
      (event) =>
        event.tool === "skill_retrieve" && event.skillId === environment.skill.skill.id,
    );
    expect(skillAudit).toMatchObject({ outcome: "success" });
    expect(skillAudit?.countMetric).toBeUndefined();

    const asset = parseStructured<SkillAssetRetrieveOutput>(
      await oauth.client.callTool({
        name: "skill_asset_retrieve",
        arguments: {
          skill: { id: created.skill.id },
          version: { selector: "current" },
          path: "AGENTS.md",
          responseMode: "auto",
          caller: TEST_CALLER,
        },
      }),
    );
    expect(asset).toMatchObject({ delivery: "text", text: document });
    const skillAsset = await oauth.client.callTool({
      name: "skill_asset_retrieve",
      arguments: {
        skill: { id: environment.skill.skill.id },
        version: { selector: "current" },
        path: "AGENTS.md",
        responseMode: "auto",
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(skillAsset).error.code).toBe("SKILL_PATH_INVALID");

    const extraFile = await oauth.client.callTool({
      name: "skill_amend",
      arguments: {
        skillId: created.skill.id,
        baseVersionId: created.version.id,
        idempotencyKey: `instructions-amend-extra-${suffix}`,
        proposedBump: "patch",
        changes: [
          {
            operation: "add",
            path: "references/notes.md",
            expectedSha256: null,
            content: "# Notes\n",
          },
        ],
        learning,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(extraFile).error.code).toBe("SKILL_BUNDLE_INVALID");

    const amendedDocument = `${document}\nNever push without a passing pnpm lint.\n`;
    const amendment = parseStructured<SkillAmendOutput>(
      await oauth.client.callTool({
        name: "skill_amend",
        arguments: {
          skillId: created.skill.id,
          baseVersionId: created.version.id,
          idempotencyKey: `instructions-amend-${suffix}`,
          proposedBump: "minor",
          changes: [
            {
              operation: "replace",
              path: "AGENTS.md",
              expectedSha256: sha256(document),
              content: amendedDocument,
            },
          ],
          learning,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(amendment.review.status).toBe("pending");
    const pending = parseStructured<SkillCandidatesListOutput>(
      await oauth.client.callTool({
        name: "skill_candidates_list",
        arguments: {
          skill: { id: created.skill.id },
          status: "pending",
          caller: TEST_CALLER,
        },
      }),
    );
    const approved = parseStructured<SkillCandidateDecisionOutput>(
      await oauth.client.callTool({
        name: "skill_candidate_approve",
        arguments: {
          skill: { id: created.skill.id },
          reviewId: amendment.review.id,
          expectedUpdatedAt: pending.candidates[0]?.review.updatedAt,
          reason: "The repository command is now explicit",
          idempotencyKey: `instructions-approve-${suffix}`,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(approved.result.candidate).toMatchObject({
      revision: 2,
      state: "published",
      semanticVersion: "1.1.0",
    });

    const current = parseStructured<SkillRetrieveOutput>(
      await oauth.client.callTool({
        name: "skill_retrieve",
        arguments: { skill: { id: created.skill.id }, caller: TEST_CALLER },
      }),
    );
    expect(current).toMatchObject({
      skill: { kind: "instructions" },
      version: {
        id: approved.result.candidate.id,
        revision: 2,
        digest: approved.result.candidate.digest,
      },
      instructions: amendedDocument,
    });

    const listed = parseStructured<SkillsListOutput>(
      await oauth.client.callTool({
        name: "skills_list",
        arguments: {
          workspace: { id: environment.owner.workspaceId },
          limit: 100,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(listed.skills.find((item) => item.id === created.skill.id)?.kind).toBe(
      "instructions",
    );
    // Skills omit kind so strict clients from before artifact kinds still parse.
    expect(
      listed.skills.find((item) => item.id === environment.skill.skill.id),
    ).not.toHaveProperty("kind");

    const searched = parseStructured<SkillsSearchOutput>(
      await oauth.client.callTool({
        name: "skills_search",
        arguments: {
          workspace: { id: environment.owner.workspaceId },
          query: "repository agents",
          caller: TEST_CALLER,
        },
      }),
    );
    expect(searched.skills.find((item) => item.id === created.skill.id)?.kind).toBe(
      "instructions",
    );

    const resolved = await oauth.client.callTool({
      name: "skill_resolve",
      arguments: {
        skill: { id: created.skill.id },
        version: { selector: "current" },
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(resolved).error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { kind: "instructions" },
    });
    const composed = await oauth.client.callTool({
      name: "skill_composition_candidate_create",
      arguments: {
        skill: { id: created.skill.id },
        version: { selector: "current" },
        dependencies: [],
        proposedBump: "minor",
        changeSummary: "Compose instructions",
        idempotencyKey: `instructions-compose-${suffix}`,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(composed).error.code).toBe("VALIDATION_FAILED");
    // Upgrades reach the shared CompositionService kind guard.
    for (const [name, extra] of [
      ["skill_dependency_upgrades_get", {}],
      [
        "skill_dependency_upgrade",
        { idempotencyKey: `instructions-upgrade-${suffix}` },
      ],
    ] as const) {
      const upgrade = await oauth.client.callTool({
        name,
        arguments: {
          skill: { id: created.skill.id },
          version: { selector: "current" },
          caller: TEST_CALLER,
          ...extra,
        },
      });
      expect(parseToolError(upgrade).error, name).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { kind: "instructions" },
      });
    }

    // A root AGENTS.md stays an up-front, non-retryable path error for skills.
    const skillWithAgents = await oauth.client.callTool({
      name: "skill_create",
      arguments: {
        workspace: { id: environment.owner.workspaceId },
        slug: `skill-with-agents-${suffix}`,
        name: "Skill with agents",
        instructions: "# Skill\n",
        assets: [{ path: "AGENTS.md", content: "# Agents\n" }],
        idempotencyKey: `instructions-skill-agents-${suffix}`,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(skillWithAgents).error).toMatchObject({
      code: "SKILL_PATH_INVALID",
      retryable: false,
    });
    const skillAmendAgents = await oauth.client.callTool({
      name: "skill_amend",
      arguments: {
        skillId: environment.skill.skill.id,
        baseVersionId: environment.skill.version.id,
        idempotencyKey: `instructions-skill-amend-agents-${suffix}`,
        proposedBump: "patch",
        changes: [
          {
            operation: "add",
            path: "AGENTS.md",
            expectedSha256: null,
            content: "# Agents\n",
          },
        ],
        learning,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(skillAmendAgents).error).toMatchObject({
      code: "SKILL_PATH_INVALID",
      retryable: false,
    });

    const workspace = await environment.services.database.pool.query<{ slug: string }>(
      "SELECT slug FROM workspaces WHERE id = $1",
      [environment.owner.workspaceId],
    );
    const dependent = await oauth.client.callTool({
      name: "skill_create",
      arguments: {
        workspace: { id: environment.owner.workspaceId },
        slug: `depends-on-agents-${suffix}`,
        name: "Depends on agents",
        visibility: "workspace",
        instructions: "# Composite\n\nUse the repository guidance.\n",
        composition: {
          dependencies: [
            {
              alias: "agents",
              workspace: workspace.rows[0]?.slug,
              skill: slug,
              version: "^1.0.0",
              scope: "execution",
              mode: "include",
            },
          ],
        },
        idempotencyKey: `instructions-dependent-${suffix}`,
        caller: TEST_CALLER,
      },
    });
    const dependencyError = parseToolError(dependent).error;
    expect(dependencyError.code).toBe("SKILL_DEPENDENCY_CONFLICT");
    expect(dependencyError.message).toContain("instructions document");
  });
});
