import type {
  SkillAmendmentPolicyOutput,
  SkillAmendOutput,
  SkillCandidateDecisionOutput,
  SkillCandidatesListOutput,
  SkillCreateOutput,
  SkillLifecycleMutationOutput,
  SkillsListOutput,
  SkillVersionsDiffOutput,
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
  environment = await startMcpTestEnvironment("skill-lifecycle");
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

function learning(summary: string) {
  return {
    summary,
    observation: "The production lifecycle required an immutable skill revision.",
    rationale: "Agents need reviewable skill evolution with durable evidence.",
    confidence: "high",
    evidence: [
      {
        kind: "integration",
        reference: TEST_CALLER.runId,
        description: "The complete MCP lifecycle was exercised.",
      },
    ],
    validation: [
      {
        kind: "integration",
        status: "passed",
        description: "Lifecycle state and audit records were verified.",
      },
    ],
  } as const;
}

async function listedSkill(skillId: string) {
  const output = parseStructured<SkillsListOutput>(
    await oauth.client.callTool({
      name: "skills_list",
      arguments: {
        workspace: { id: environment.owner.workspaceId },
        state: "all",
        limit: 100,
        caller: TEST_CALLER,
      },
    }),
  );
  const skill = output.skills.find((item) => item.id === skillId);
  if (!skill) throw new Error("Created lifecycle skill was not listed");
  return skill;
}

describe("MCP skill lifecycle", () => {
  it("creates, governs, reviews, diffs, publishes, rejects, archives, and restores a skill", async () => {
    await oauth.client.listTools();
    const suffix = crypto.randomUUID().slice(0, 8);
    const slug = `agent-skill-${suffix}`;
    const initialInstructions =
      "# Agent-managed skill\n\nInspect live authorization state before acting.\n";
    const createArguments = {
      workspace: { id: environment.owner.workspaceId },
      slug,
      name: "Agent-managed skill",
      description: "Created and governed entirely through MCP",
      tags: ["agent", "lifecycle"],
      visibility: "private",
      instructions: initialInstructions,
      assets: [
        {
          path: "references/checklist.md",
          content: "# Checklist\n\n- Verify authorization\n",
        },
        { path: "assets/marker.bin", contentBase64: "AAEC/w==" },
      ],
      idempotencyKey: `skill-create-${suffix}`,
      caller: TEST_CALLER,
    } as const;
    const created = parseStructured<SkillCreateOutput>(
      await oauth.client.callTool({
        name: "skill_create",
        arguments: createArguments,
      }),
    );
    const replay = parseStructured<SkillCreateOutput>(
      await oauth.client.callTool({
        name: "skill_create",
        arguments: createArguments,
      }),
    );
    expect(replay.skill.id).toBe(created.skill.id);
    expect(created).toMatchObject({
      skill: {
        slug,
        visibility: "private",
        currentVersion: { semanticVersion: "1.0.0" },
        archivedAt: null,
      },
      version: {
        revision: 1,
        semanticVersion: "1.0.0",
        state: "published",
      },
    });
    const changedReplay = await oauth.client.callTool({
      name: "skill_create",
      arguments: { ...createArguments, name: "Changed replay" },
    });
    expect(parseToolError(changedReplay).error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const initialPolicy = parseStructured<SkillAmendmentPolicyOutput>(
      await oauth.client.callTool({
        name: "skill_amendment_policy_get",
        arguments: { skill: { id: created.skill.id }, caller: TEST_CALLER },
      }),
    );
    expect(initialPolicy).toMatchObject({
      skillId: created.skill.id,
      skillUpdatedAt: created.skill.updatedAt,
      policy: { mode: "review_required" },
    });
    const policy = parseStructured<SkillAmendmentPolicyOutput>(
      await oauth.client.callTool({
        name: "skill_amendment_policy_update",
        arguments: {
          skill: { id: created.skill.id },
          policy: { mode: "review_required" },
          expectedUpdatedAt: initialPolicy.skillUpdatedAt,
          idempotencyKey: `skill-policy-${suffix}`,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(Date.parse(policy.skillUpdatedAt)).toBeGreaterThan(
      Date.parse(initialPolicy.skillUpdatedAt),
    );
    const stalePolicy = await oauth.client.callTool({
      name: "skill_amendment_policy_update",
      arguments: {
        skill: { id: created.skill.id },
        policy: { mode: "review_required" },
        expectedUpdatedAt: initialPolicy.skillUpdatedAt,
        idempotencyKey: `skill-policy-stale-${suffix}`,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(stalePolicy).error).toMatchObject({
      code: "SKILL_METADATA_CONFLICT",
      details: { currentUpdatedAt: policy.skillUpdatedAt },
    });

    const approvedInstructions = `${initialInstructions}\nRequire immutable review evidence.\n`;
    const firstAmendment = parseStructured<SkillAmendOutput>(
      await oauth.client.callTool({
        name: "skill_amend",
        arguments: {
          skillId: created.skill.id,
          baseVersionId: created.version.id,
          idempotencyKey: `skill-amend-approve-${suffix}`,
          proposedBump: "patch",
          changes: [
            {
              operation: "replace",
              path: "SKILL.md",
              expectedSha256: sha256(initialInstructions),
              content: approvedInstructions,
            },
          ],
          learning: learning("Add immutable review evidence"),
          caller: TEST_CALLER,
        },
      }),
    );
    expect(firstAmendment).toMatchObject({
      candidate: { state: "candidate", semanticVersion: null },
      review: { status: "pending" },
    });

    const pending = parseStructured<SkillCandidatesListOutput>(
      await oauth.client.callTool({
        name: "skill_candidates_list",
        arguments: {
          skill: { id: created.skill.id },
          status: "pending",
          limit: 1,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(pending.candidates).toHaveLength(1);
    expect(pending.candidates[0]).toMatchObject({
      review: {
        id: firstAmendment.review.id,
        requestedBy: {
          agent: TEST_CALLER.agentName,
          model: TEST_CALLER.modelName,
        },
      },
      candidate: { id: firstAmendment.candidate.id },
    });

    const diff = parseStructured<SkillVersionsDiffOutput>(
      await oauth.client.callTool({
        name: "skill_versions_diff",
        arguments: {
          skill: { id: created.skill.id },
          fromVersionId: created.version.id,
          toVersionId: firstAmendment.candidate.id,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "SKILL.md", status: "modified" }),
      ]),
    );

    const approved = parseStructured<SkillCandidateDecisionOutput>(
      await oauth.client.callTool({
        name: "skill_candidate_approve",
        arguments: {
          skill: { id: created.skill.id },
          reviewId: firstAmendment.review.id,
          expectedUpdatedAt: pending.candidates[0]?.review.updatedAt,
          reason: "Integration evidence passed",
          idempotencyKey: `skill-approve-${suffix}`,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(approved.result).toMatchObject({
      review: { status: "approved" },
      candidate: { state: "published", semanticVersion: "1.0.1" },
    });

    const rejectedInstructions = `${approvedInstructions}\nUnsafe unverified shortcut.\n`;
    const secondAmendment = parseStructured<SkillAmendOutput>(
      await oauth.client.callTool({
        name: "skill_amend",
        arguments: {
          skillId: created.skill.id,
          baseVersionId: approved.result.candidate.id,
          idempotencyKey: `skill-amend-reject-${suffix}`,
          proposedBump: "patch",
          changes: [
            {
              operation: "replace",
              path: "SKILL.md",
              expectedSha256: sha256(approvedInstructions),
              content: rejectedInstructions,
            },
          ],
          learning: learning("Propose an unsafe shortcut for rejection coverage"),
          caller: TEST_CALLER,
        },
      }),
    );
    const allCandidates: SkillCandidatesListOutput["candidates"] = [];
    let cursor: string | null = null;
    do {
      const page = parseStructured<SkillCandidatesListOutput>(
        await oauth.client.callTool({
          name: "skill_candidates_list",
          arguments: {
            skill: { id: created.skill.id },
            status: "all",
            limit: 1,
            cursor,
            caller: TEST_CALLER,
          },
        }),
      );
      allCandidates.push(...page.candidates);
      cursor = page.nextCursor;
    } while (cursor);
    expect(allCandidates.map((item) => item.review.id)).toEqual(
      expect.arrayContaining([firstAmendment.review.id, secondAmendment.review.id]),
    );
    const secondReview = allCandidates.find(
      (item) => item.review.id === secondAmendment.review.id,
    );
    if (!secondReview) throw new Error("Second amendment review was not listed");
    const rejected = parseStructured<SkillCandidateDecisionOutput>(
      await oauth.client.callTool({
        name: "skill_candidate_reject",
        arguments: {
          skill: { id: created.skill.id },
          reviewId: secondAmendment.review.id,
          expectedUpdatedAt: secondReview.review.updatedAt,
          reason: "The shortcut bypasses required verification",
          idempotencyKey: `skill-reject-${suffix}`,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(rejected.result).toMatchObject({
      review: { status: "rejected" },
      candidate: { state: "rejected", semanticVersion: null },
    });

    const latest = await listedSkill(created.skill.id);
    const visibility = parseStructured<SkillLifecycleMutationOutput>(
      await oauth.client.callTool({
        name: "skill_visibility_update",
        arguments: {
          skill: { id: created.skill.id },
          visibility: "workspace",
          expectedUpdatedAt: latest.updatedAt,
          idempotencyKey: `skill-visibility-${suffix}`,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(visibility.skill.visibility).toBe("workspace");
    const staleVisibility = await oauth.client.callTool({
      name: "skill_visibility_update",
      arguments: {
        skill: { id: created.skill.id },
        visibility: "public",
        expectedUpdatedAt: latest.updatedAt,
        idempotencyKey: `skill-visibility-stale-${suffix}`,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(staleVisibility).error.code).toBe("SKILL_METADATA_CONFLICT");

    const archived = parseStructured<SkillLifecycleMutationOutput>(
      await oauth.client.callTool({
        name: "skill_archive",
        arguments: {
          skill: { id: created.skill.id },
          expectedUpdatedAt: visibility.skill.updatedAt,
          idempotencyKey: `skill-archive-${suffix}`,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(archived.skill.archivedAt).toEqual(expect.any(String));
    const restored = parseStructured<SkillLifecycleMutationOutput>(
      await oauth.client.callTool({
        name: "skill_restore",
        arguments: {
          skill: { id: created.skill.id },
          expectedUpdatedAt: archived.skill.updatedAt,
          idempotencyKey: `skill-restore-${suffix}`,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(restored.skill.archivedAt).toBeNull();

    const audit = await environment.services.database.pool.query<{
      event_type: string;
      agent: string | null;
      model: string | null;
    }>(
      `SELECT event_type, agent, model
         FROM audit_events
        WHERE metadata->>'skillId' = $1
          AND event_type IN (
            'skill.created', 'skill.visibility_changed',
            'skill.archived', 'skill.restored',
            'skill.amendment_policy.updated',
            'amendment.review.approved', 'amendment.review.rejected'
          )
        ORDER BY event_type`,
      [created.skill.id],
    );
    expect(new Set(audit.rows.map((row) => row.event_type))).toEqual(
      new Set([
        "skill.created",
        "skill.visibility_changed",
        "skill.archived",
        "skill.restored",
        "skill.amendment_policy.updated",
        "amendment.review.approved",
        "amendment.review.rejected",
      ]),
    );
    const firstCandidatePage = parseStructured<SkillCandidatesListOutput>(
      await oauth.client.callTool({
        name: "skill_candidates_list",
        arguments: {
          skill: { id: created.skill.id },
          status: "all",
          limit: 1,
          caller: TEST_CALLER,
        },
      }),
    );
    const cursorMismatch = await oauth.client.callTool({
      name: "skill_candidates_list",
      arguments: {
        skill: { id: created.skill.id },
        status: "pending",
        limit: 1,
        cursor: firstCandidatePage.nextCursor,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(cursorMismatch).error.code).toBe("CURSOR_FILTER_MISMATCH");
    expect(audit.rows.every((row) => row.agent === TEST_CALLER.agentName)).toBe(true);
    expect(audit.rows.every((row) => row.model === TEST_CALLER.modelName)).toBe(true);
  });
});
