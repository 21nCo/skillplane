import type { ContextNoteMutationOutput } from "@skillplane/mcp-schema";
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

beforeAll(async () => {
  environment = await startMcpTestEnvironment("mutation-security");
  service = await environment.connect(environment.serviceToken);
}, 60_000);

afterAll(async () => {
  await environment?.close();
}, 30_000);

function skillSha(): string {
  const file = environment.skill.version.manifest.files.find(
    (candidate) => candidate.path === "SKILL.md",
  );
  if (!file) throw new Error("Fixture SKILL.md descriptor is missing");
  return file.sha256;
}

function amendment(key: string, path = "SKILL.md") {
  return {
    skillId: environment.skill.skill.id,
    baseVersionId: environment.skill.version.id,
    idempotencyKey: key,
    proposedBump: "patch",
    changes: [
      {
        operation: "replace",
        path,
        expectedSha256: skillSha(),
        content: `${environment.skill.markdown}\nSecurity-tested amendment ${key}.\n`,
      },
    ],
    learning: {
      summary: "Security-test amendment",
      observation: "A controlled fixture exposed an unsafe mutation path.",
      rationale: "The MCP surface must reject the mutation before durable commit.",
      confidence: "high",
      evidence: [
        {
          kind: "test",
          reference: TEST_CALLER.runId,
          description: "The release security matrix exercised this path.",
        },
      ],
      validation: [
        {
          kind: "automated",
          status: "passed",
          description: "Database and storage state were checked after rejection.",
        },
      ],
    },
    caller: TEST_CALLER,
  };
}

describe("MCP mutation authorization and isolation", () => {
  it("rejects missing write scopes before mutation execution", async () => {
    const before = await environment.services.database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM skill_versions WHERE skill_id = $1",
      [environment.skill.skill.id],
    );
    const response = await environment.rawMcp(environment.skillsOnlyToken, {
      jsonrpc: "2.0",
      id: 70,
      method: "tools/call",
      params: {
        name: "skill_amend",
        arguments: amendment("scope-denied"),
      },
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('scope="skills:amend"');
    await expect(response.json()).resolves.toMatchObject({
      error: "insufficient_scope",
    });
    const after = await environment.services.database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM skill_versions WHERE skill_id = $1",
      [environment.skill.skill.id],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

    const noteResponse = await environment.rawMcp(environment.skillsOnlyToken, {
      jsonrpc: "2.0",
      id: 71,
      method: "tools/call",
      params: {
        name: "context_note_upsert",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          title: "Denied",
          markdown: "This note must not be written.",
          idempotencyKey: "scope-denied-note",
          caller: TEST_CALLER,
        },
      },
    });
    expect(noteResponse.status).toBe(403);
    expect(noteResponse.headers.get("www-authenticate")).toContain(
      'scope="contexts:write"',
    );

    const contextResponse = await environment.rawMcp(environment.skillsOnlyToken, {
      jsonrpc: "2.0",
      id: 72,
      method: "tools/call",
      params: {
        name: "context_create",
        arguments: {
          skill: { id: environment.skill.skill.id },
          slug: "scope-denied-context",
          name: "Denied context",
          type: "custom",
          initialKnowledge: "This context must not be created.",
          idempotencyKey: "scope-denied-context",
          caller: TEST_CALLER,
        },
      },
    });
    expect(contextResponse.status).toBe(403);
    expect(contextResponse.headers.get("www-authenticate")).toContain(
      'scope="contexts:write"',
    );
  });

  it("enforces workspace role even when the credential carries mutation scopes", async () => {
    const viewerToken = `sps_${crypto.randomUUID().replaceAll("-", "")}${crypto
      .randomUUID()
      .replaceAll("-", "")}`;
    await environment.services.database.pool.query(
      `INSERT INTO service_principals
         (id, workspace_id, name, role, scopes, credential_hash,
          created_by_user_id)
       VALUES ($1, $2, $3, 'viewer', $4, $5, $6)`,
      [
        `service-principal:mcp-viewer-write-${crypto.randomUUID()}`,
        environment.owner.workspaceId,
        `MCP viewer write ${crypto.randomUUID()}`,
        ["skills:read", "skills:amend", "contexts:read", "contexts:write"],
        createHash("sha256").update(viewerToken).digest("hex"),
        environment.owner.userId,
      ],
    );
    const viewer = await environment.connect(viewerToken);
    const readsBefore = environment.storage.getCalls;
    const result = await viewer.client.callTool({
      name: "skill_amend",
      arguments: amendment("viewer-role-denied"),
    });
    expect(parseToolError(result).error.code).toBe("SKILL_NOT_FOUND");
    expect(environment.storage.getCalls).toBe(readsBefore);
    const committed = await environment.services.database.pool.query<{
      count: string;
    }>(
      `SELECT count(*)::text AS count
         FROM skill_versions
        WHERE skill_id = $1
          AND learning_metadata->>'summary' = 'Security-test amendment'`,
      [environment.skill.skill.id],
    );
    expect(committed.rows[0]?.count).toBe("0");
  });

  it("returns stable safe errors for traversal, stale bases, and invalid learning", async () => {
    const readsBefore = environment.storage.getCalls;
    const traversal = await service.client.callTool({
      name: "skill_amend",
      arguments: amendment("unsafe-path", "../../x"),
    });
    expect(parseToolError(traversal).error.code).toBe("SKILL_PATH_INVALID");
    expect(environment.storage.getCalls).toBe(readsBefore);

    const stale = await service.client.callTool({
      name: "skill_amend",
      arguments: {
        ...amendment("stale-base"),
        baseVersionId: environment.skill.candidate.id,
      },
    });
    expect(parseToolError(stale).error).toMatchObject({
      code: "SKILL_VERSION_CONFLICT",
      details: {
        currentVersionId: environment.skill.version.id,
      },
    });

    const invalid = await service.client.callTool({
      name: "skill_amend",
      arguments: {
        ...amendment("invalid-learning"),
        learning: {
          ...amendment("unused").learning,
          evidence: [],
          evidenceUnavailableReason: null,
        },
      },
    });
    expect(parseToolError(invalid).error.code).toBe("LEARNING_METADATA_INVALID");
    expect(JSON.stringify(invalid)).not.toContain("postgres");
    expect(JSON.stringify(invalid)).not.toContain(environment.serviceToken);
  });

  it("prevents a note ID from crossing its selected skill context", async () => {
    const owner: UserPrincipal = {
      kind: "user",
      actorId: environment.owner.userId,
      userId: environment.owner.userId,
      sessionId: "mcp-cross-context-fixture",
      workspaceId: environment.owner.workspaceId,
      role: "owner",
    };
    const otherContext = await environment.services.contextService.create({
      skillId: environment.privateSkill.skill.id,
      principal: owner,
      slug: `other-${crypto.randomUUID().slice(0, 8)}`,
      name: "Other skill context",
      type: "project",
      initialKnowledge: "Other skill knowledge.",
      idempotencyKey: "other-context",
      requestId: "fixture:other-context",
    });
    const otherNote = await environment.services.contextNoteService.create({
      contextId: otherContext.context.id,
      principal: owner,
      title: "Other skill note",
      body: "This note belongs to another skill.",
      idempotencyKey: "other-context-note",
      requestId: "fixture:other-context-note",
    });
    const crossSkillContext = await service.client.callTool({
      name: "context_update",
      arguments: {
        skill: { id: environment.skill.skill.id },
        context: { id: otherContext.context.id },
        expectedUpdatedAt: otherContext.context.updatedAt,
        patch: { description: "Cross-skill overwrite" },
        idempotencyKey: "cross-skill-context",
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(crossSkillContext).error.code).toBe("CONTEXT_NOT_FOUND");
    const result = await service.client.callTool({
      name: "context_note_upsert",
      arguments: {
        skill: { id: environment.skill.skill.id },
        context: { id: environment.skill.context.context.id },
        noteId: otherNote.id,
        expectedRevision: 1,
        title: "Cross-skill overwrite",
        markdown: "This write must be denied.",
        idempotencyKey: "cross-skill-note",
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(result).error.code).toBe("NOTE_NOT_FOUND");
    const unchanged = await environment.services.contextNoteService.get({
      noteId: otherNote.id,
      principal: owner,
    });
    expect(unchanged.body).toBe("This note belongs to another skill.");
    expect(unchanged.currentRevision).toBe(1);
  });

  it("rolls back candidate, R2 object, and context revision when mutation audit fails", async () => {
    const credential = await environment.services.database.pool.query<{ id: string }>(
      "SELECT id FROM service_principals WHERE credential_hash = $1",
      [createHash("sha256").update(environment.serviceToken).digest("hex")],
    );
    const actorId = credential.rows[0]?.id;
    if (!actorId) throw new Error("Fixture service principal was not found");
    const functionName = `fail_mutation_audit_${crypto
      .randomUUID()
      .replaceAll("-", "")
      .slice(0, 12)}`;
    const triggerName = `${functionName}_trigger`;
    await environment.services.database.pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.actor_id = '${actorId.replaceAll("'", "''")}'
            AND NEW.event_type IN (
              'skill.amendment.created',
              'context.knowledge.revised',
              'context.created'
            ) THEN
           RAISE EXCEPTION 'forced mutation audit failure';
         END IF;
         RETURN NEW;
       END;
       $$;
       CREATE TRIGGER ${triggerName}
       BEFORE INSERT ON audit_events
       FOR EACH ROW EXECUTE FUNCTION ${functionName}();`,
    );
    try {
      const versionsBefore = await environment.services.database.pool.query<{
        count: string;
      }>("SELECT count(*)::text AS count FROM skill_versions WHERE skill_id = $1", [
        environment.skill.skill.id,
      ]);
      const objectsBefore = environment.storage.inventory().map((item) => item.key);
      const failedAmendment = await service.client.callTool({
        name: "skill_amend",
        arguments: amendment("audit-failure-amendment"),
      });
      expect(parseToolError(failedAmendment).error).toMatchObject({
        code: "AUDIT_WRITE_FAILED",
        retryable: true,
      });
      const versionsAfter = await environment.services.database.pool.query<{
        count: string;
      }>("SELECT count(*)::text AS count FROM skill_versions WHERE skill_id = $1", [
        environment.skill.skill.id,
      ]);
      expect(versionsAfter.rows[0]?.count).toBe(versionsBefore.rows[0]?.count);
      expect(environment.storage.inventory().map((item) => item.key)).toEqual(
        objectsBefore,
      );

      const currentBefore = await environment.services.database.pool.query<{
        current_knowledge_revision_id: string;
      }>("SELECT current_knowledge_revision_id FROM skill_contexts WHERE id = $1", [
        environment.skill.context.context.id,
      ]);
      const failedKnowledge = await service.client.callTool({
        name: "context_knowledge_update",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          expectedRevision: environment.skill.context.knowledge.revision,
          markdown: "This revision must roll back with its audit.",
          idempotencyKey: "audit-failure-knowledge",
          caller: TEST_CALLER,
        },
      });
      expect(parseToolError(failedKnowledge).error).toMatchObject({
        code: "AUDIT_WRITE_FAILED",
        retryable: true,
      });
      const currentAfter = await environment.services.database.pool.query<{
        current_knowledge_revision_id: string;
      }>("SELECT current_knowledge_revision_id FROM skill_contexts WHERE id = $1", [
        environment.skill.context.context.id,
      ]);
      expect(currentAfter.rows[0]?.current_knowledge_revision_id).toBe(
        currentBefore.rows[0]?.current_knowledge_revision_id,
      );

      const contextsBefore = await environment.services.database.pool.query<{
        count: string;
      }>("SELECT count(*)::text AS count FROM skill_contexts WHERE skill_id = $1", [
        environment.skill.skill.id,
      ]);
      const failedContext = await service.client.callTool({
        name: "context_create",
        arguments: {
          skill: { id: environment.skill.skill.id },
          slug: `audit-failure-${crypto.randomUUID().slice(0, 8)}`,
          name: "Audit failure context",
          type: "custom",
          initialKnowledge: "This context must roll back with its audit.",
          idempotencyKey: "audit-failure-context",
          caller: TEST_CALLER,
        },
      });
      expect(parseToolError(failedContext).error).toMatchObject({
        code: "AUDIT_WRITE_FAILED",
        retryable: true,
      });
      const contextsAfter = await environment.services.database.pool.query<{
        count: string;
      }>("SELECT count(*)::text AS count FROM skill_contexts WHERE skill_id = $1", [
        environment.skill.skill.id,
      ]);
      expect(contextsAfter.rows[0]?.count).toBe(contextsBefore.rows[0]?.count);
    } finally {
      await environment.services.database.pool.query(
        `DROP TRIGGER IF EXISTS ${triggerName} ON audit_events;
         DROP FUNCTION IF EXISTS ${functionName}();`,
      );
    }
  });
});

describe("MCP context caller provenance", () => {
  it("stores authenticated principal and caller-declared agent/model separately", async () => {
    const created = parseStructured<ContextNoteMutationOutput>(
      await service.client.callTool({
        name: "context_note_upsert",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          title: "Caller provenance",
          markdown: "Keep authenticated and declared identities separate.",
          idempotencyKey: "caller-provenance-note",
          caller: TEST_CALLER,
        },
      }),
    );
    const revision = await environment.services.database.pool.query<{
      created_by_actor_id: string;
      created_by_agent: string;
      created_by_model: string;
      created_for_user_id: string | null;
    }>(
      `SELECT created_by_actor_id, created_by_agent, created_by_model,
              created_for_user_id
         FROM context_note_revisions
        WHERE id = $1`,
      [created.note.currentRevision.id],
    );
    expect(revision.rows[0]).toMatchObject({
      created_by_agent: TEST_CALLER.agentName,
      created_by_model: TEST_CALLER.modelName,
      created_for_user_id: null,
    });
    expect(revision.rows[0]?.created_by_actor_id).not.toBe(TEST_CALLER.agentId);
  });
});
