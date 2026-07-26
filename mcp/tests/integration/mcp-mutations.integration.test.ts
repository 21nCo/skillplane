import type {
  ContextKnowledgeMutationOutput,
  ContextNoteMutationOutput,
  SkillAmendOutput,
} from "@skillplane/mcp-schema";
import type { UserPrincipal } from "@skillplane/domain";
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
let service: ConnectedMcpClient;
let oauth: ConnectedMcpClient;

beforeAll(async () => {
  environment = await startMcpTestEnvironment("mutations");
  service = await environment.connect(environment.serviceToken);
  oauth = await environment.connect(
    await environment.issueOAuthToken(
      "skills:read skills:amend contexts:read contexts:write",
    ),
  );
}, 60_000);

afterAll(async () => {
  await environment.close();
}, 30_000);

function baseFileSha(path: string): string {
  const file = environment.skill.version.manifest.files.find(
    (candidate) => candidate.path === path,
  );
  if (!file) throw new Error(`Missing fixture file ${path}`);
  return file.sha256;
}

function learning(summary: string) {
  return {
    summary,
    observation: "An authoritative server-side review changed the result.",
    rationale: "The reusable skill must inspect live review state before concluding.",
    confidence: "high",
    evidence: [
      {
        kind: "run",
        reference: TEST_CALLER.runId,
        description: "The live-thread check found an unresolved review.",
      },
    ],
    validation: [
      {
        kind: "manual",
        status: "passed",
        description: "Replayed against two repository fixtures.",
      },
    ],
    sourceContextId: environment.skill.context.context.id,
    tags: ["review-threads"],
    extra: { learnedBy: TEST_CALLER.agentId },
  } as const;
}

function amendmentArguments(options: {
  readonly key: string;
  readonly content: string;
  readonly summary: string;
}) {
  return {
    skillId: environment.skill.skill.id,
    baseVersionId: environment.skill.version.id,
    idempotencyKey: options.key,
    proposedBump: "patch",
    changes: [
      {
        operation: "replace",
        path: "SKILL.md",
        expectedSha256: baseFileSha("SKILL.md"),
        content: options.content,
      },
    ],
    learning: learning(options.summary),
    caller: TEST_CALLER,
  };
}

describe("MCP skill amendments", () => {
  it("creates one audited review candidate and replays the original candidate", async () => {
    const args = amendmentArguments({
      key: "mcp-amendment-replay",
      content: `${environment.skill.markdown}\nInspect live review threads before local diffs.\n`,
      summary: "Add live review-thread handling",
    });
    const first = parseStructured<SkillAmendOutput>(
      await service.client.callTool({ name: "skill_amend", arguments: args }),
    );
    const replay = parseStructured<SkillAmendOutput>(
      await service.client.callTool({ name: "skill_amend", arguments: args }),
    );
    expect(first).toMatchObject({
      skillId: environment.skill.skill.id,
      baseVersionId: environment.skill.version.id,
      candidate: { state: "candidate", semanticVersion: null },
      review: { status: "pending" },
      policyDecision: {
        outcome: "review_required",
        reason: "policy_requires_review",
      },
      autoPublished: false,
    });
    expect(replay.candidate.id).toBe(first.candidate.id);

    const persisted = await environment.services.database.pool.query<{
      learning_metadata: Record<string, unknown>;
      caller_declaration: Record<string, unknown>;
    }>(
      `SELECT learning_metadata, caller_declaration
         FROM skill_versions
        WHERE id = $1`,
      [first.candidate.id],
    );
    expect(persisted.rows[0]).toMatchObject({
      learning_metadata: {
        summary: "Add live review-thread handling",
        sourceContextId: environment.skill.context.context.id,
        sourceContextRevisionId: environment.skill.context.knowledge.id,
      },
      caller_declaration: {
        agent: TEST_CALLER.agentName,
        model: TEST_CALLER.modelName,
        runId: TEST_CALLER.runId,
      },
    });
    const audit = await environment.services.database.pool.query<{
      request_id: string;
      actor_type: string;
      actor_id: string;
      user_id: string | null;
      agent: string;
      model: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT request_id, actor_type, actor_id, user_id, agent, model, metadata
         FROM audit_events
        WHERE event_type = 'skill.amendment.created'
          AND resource_id = $1`,
      [first.candidate.id],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      request_id: first.requestId,
      actor_type: "service_principal",
      user_id: null,
      agent: TEST_CALLER.agentName,
      model: TEST_CALLER.modelName,
      metadata: {
        channel: "mcp",
        credential: { kind: "service_principal" },
        caller: {
          agentId: TEST_CALLER.agentId,
          modelVersion: TEST_CALLER.modelVersion,
          trust: "caller-declared",
        },
      },
    });

    const changed = await service.client.callTool({
      name: "skill_amend",
      arguments: amendmentArguments({
        key: "mcp-amendment-replay",
        content: `${environment.skill.markdown}\nDifferent payload.\n`,
        summary: "Different payload",
      }),
    });
    expect(parseToolError(changed).error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const candidateCount = await environment.services.database.pool.query<{
      count: string;
    }>(
      `SELECT count(*)::text AS count
         FROM skill_versions
        WHERE skill_id = $1 AND source = 'agent_amendment'
          AND learning_metadata->>'summary' = $2`,
      [environment.skill.skill.id, "Add live review-thread handling"],
    );
    expect(candidateCount.rows[0]?.count).toBe("1");
  });

  it("auto-publishes only after an explicit trusted credential policy decision", async () => {
    const credential = await environment.services.database.pool.query<{
      id: string;
    }>("SELECT id FROM service_principals WHERE credential_hash = $1", [
      createHash("sha256").update(environment.serviceToken).digest("hex"),
    ]);
    const credentialId = credential.rows[0]?.id;
    if (!credentialId) throw new Error("Fixture service principal was not found");
    const owner: UserPrincipal = {
      kind: "user",
      actorId: environment.owner.userId,
      userId: environment.owner.userId,
      sessionId: "mcp-policy-fixture",
      workspaceId: environment.owner.workspaceId,
      role: "owner",
    };
    await environment.services.amendmentPolicyService.update({
      skillId: environment.skill.skill.id,
      principal: owner,
      policy: {
        mode: "trusted_auto_publish",
        rules: [
          {
            credentialId,
            requiredScopes: ["skills:amend"],
            maxBump: "patch",
            allowedContextIds: [environment.skill.context.context.id],
            dailyLimit: 5,
          },
        ],
      },
      idempotencyKey: "mcp-trusted-policy",
      requestId: "fixture:mcp-trusted-policy",
    });
    const outsidePolicy = parseStructured<SkillAmendOutput>(
      await service.client.callTool({
        name: "skill_amend",
        arguments: {
          ...amendmentArguments({
            key: "mcp-amendment-policy-major",
            content: `${environment.skill.markdown}\nMajor changes require review.\n`,
            summary: "Major change outside trusted policy",
          }),
          proposedBump: "major",
        },
      }),
    );
    expect(outsidePolicy).toMatchObject({
      candidate: { state: "candidate", semanticVersion: null },
      review: { status: "pending" },
      policyDecision: {
        outcome: "review_required",
        reason: "bump_exceeds_limit",
      },
      autoPublished: false,
    });
    const output = parseStructured<SkillAmendOutput>(
      await service.client.callTool({
        name: "skill_amend",
        arguments: amendmentArguments({
          key: "mcp-amendment-auto-publish",
          content: `${environment.skill.markdown}\nApply trusted review-thread evidence.\n`,
          summary: "Trusted review-thread improvement",
        }),
      }),
    );
    expect(output).toMatchObject({
      candidate: {
        state: "published",
        semanticVersion: "1.0.1",
      },
      review: { status: "approved" },
      policyDecision: {
        outcome: "auto_publish",
        reason: "trusted_rule_matched",
        matchedRule: 0,
      },
      autoPublished: true,
    });
    const current = await environment.services.database.pool.query<{
      current_published_version_id: string;
    }>("SELECT current_published_version_id FROM skills WHERE id = $1", [
      environment.skill.skill.id,
    ]);
    expect(current.rows[0]?.current_published_version_id).toBe(output.candidate.id);
  });
});

describe("MCP context mutations", () => {
  it("updates context knowledge once, replays safely, and returns current conflict data", async () => {
    const args = {
      skill: { id: environment.skill.skill.id },
      context: { id: environment.skill.context.context.id },
      expectedRevision: environment.skill.context.knowledge.revision,
      markdown:
        "# Repository knowledge\n\nInspect live review threads before local diff conclusions.\n",
      learningMetadata: {
        summary: "Captured authoritative review source",
        runId: TEST_CALLER.runId,
      },
      idempotencyKey: "mcp-context-knowledge-replay",
      caller: TEST_CALLER,
    };
    const first = parseStructured<ContextKnowledgeMutationOutput>(
      await service.client.callTool({
        name: "context_knowledge_update",
        arguments: args,
      }),
    );
    const replay = parseStructured<ContextKnowledgeMutationOutput>(
      await service.client.callTool({
        name: "context_knowledge_update",
        arguments: args,
      }),
    );
    expect(first.knowledge).toMatchObject({
      revision: environment.skill.context.knowledge.revision + 1,
      baseRevisionId: environment.skill.context.knowledge.id,
      learningMetadata: { summary: "Captured authoritative review source" },
    });
    expect(replay.knowledge.id).toBe(first.knowledge.id);
    const stale = await service.client.callTool({
      name: "context_knowledge_update",
      arguments: {
        ...args,
        idempotencyKey: "mcp-context-knowledge-stale",
        markdown: `${args.markdown}\nStale writer.`,
      },
    });
    expect(parseToolError(stale).error).toMatchObject({
      code: "CONTEXT_REVISION_CONFLICT",
      details: {
        currentRevision: first.knowledge.revision,
        currentRevisionId: first.knowledge.id,
      },
    });
  });

  it("creates and updates notes with immutable revisions and rejects concurrent last-write-wins", async () => {
    const created = parseStructured<ContextNoteMutationOutput>(
      await service.client.callTool({
        name: "context_note_upsert",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          title: "Review thread API",
          markdown: "Use the authoritative server-side review API.",
          learningMetadata: { source: TEST_CALLER.runId },
          idempotencyKey: "mcp-note-create",
          caller: TEST_CALLER,
        },
      }),
    );
    expect(created.note.currentRevision).toMatchObject({
      revision: 1,
      baseRevisionId: null,
    });
    const updates = await Promise.all([
      service.client.callTool({
        name: "context_note_upsert",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          noteId: created.note.id,
          expectedRevision: 1,
          title: "Review thread API",
          markdown: "Inspect unresolved live review threads first.",
          learningMetadata: { attempt: "one" },
          idempotencyKey: "mcp-note-update-one",
          caller: TEST_CALLER,
        },
      }),
      service.client.callTool({
        name: "context_note_upsert",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          noteId: created.note.id,
          expectedRevision: 1,
          title: "Review thread API",
          markdown: "Inspect the local diff first.",
          learningMetadata: { attempt: "two" },
          idempotencyKey: "mcp-note-update-two",
          caller: TEST_CALLER,
        },
      }),
    ]);
    const successes = updates.filter((result) => result.isError !== true);
    const conflicts = updates.filter((result) => result.isError === true);
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const successfulUpdate = successes[0];
    const conflictUpdate = conflicts[0];
    if (!successfulUpdate || !conflictUpdate) {
      throw new Error("Expected one successful note update and one conflict");
    }
    const updated = parseStructured<ContextNoteMutationOutput>(successfulUpdate);
    expect(updated.note.currentRevision).toMatchObject({
      revision: 2,
      baseRevisionId: created.note.currentRevision.id,
    });
    expect(parseToolError(conflictUpdate).error).toMatchObject({
      code: "NOTE_REVISION_CONFLICT",
      details: {
        currentRevision: 2,
        currentRevisionId: updated.note.currentRevision.id,
      },
    });
    const revisions = await environment.services.database.pool.query<{
      revision: number;
    }>(
      `SELECT revision
         FROM context_note_revisions
        WHERE note_id = $1
        ORDER BY revision`,
      [created.note.id],
    );
    expect(revisions.rows.map((row) => row.revision)).toEqual([1, 2]);
  });

  it("binds OAuth context writes to the authenticated user while preserving declared caller fields", async () => {
    const created = parseStructured<ContextNoteMutationOutput>(
      await oauth.client.callTool({
        name: "context_note_upsert",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          title: "OAuth principal attribution",
          markdown: "The authenticated user remains server-derived.",
          idempotencyKey: "mcp-oauth-context-note",
          caller: TEST_CALLER,
        },
      }),
    );
    const audit = await environment.services.database.pool.query<{
      actor_id: string;
      user_id: string;
      agent: string;
      model: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_id, user_id, agent, model, metadata
         FROM audit_events
        WHERE request_id = $1 AND event_type = 'context.note.created'`,
      [created.requestId],
    );
    expect(audit.rows[0]).toMatchObject({
      actor_id: environment.owner.userId,
      user_id: environment.owner.userId,
      agent: TEST_CALLER.agentName,
      model: TEST_CALLER.modelName,
      metadata: {
        channel: "mcp",
        credential: { kind: "oauth_access_token" },
        caller: {
          agentId: TEST_CALLER.agentId,
          modelName: TEST_CALLER.modelName,
          trust: "caller-declared",
        },
      },
    });
  });
});
