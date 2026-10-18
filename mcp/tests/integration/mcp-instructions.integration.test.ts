import type {
  SkillAmendOutput,
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

let environment: McpTestEnvironment;
let oauth: ConnectedMcpClient;

beforeAll(async () => {
  environment = await startMcpTestEnvironment("instructions");
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
