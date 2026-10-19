import {
  listedSkillSchema,
  skillSearchItemSchema,
  skillsListOutputSchema,
  skillsSearchOutputSchema,
  type SkillAmendOutput,
  type SkillAssetRetrieveOutput,
  type SkillCandidateDecisionOutput,
  type SkillCandidatesListOutput,
  type SkillCreateOutput,
  type SkillRetrieveOutput,
  type SkillsListOutput,
  type SkillsSearchOutput,
} from "@skillplane/mcp-schema";
import { stableJson } from "@skillplane/storage";
import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
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

// The strict list and search shapes bundled by clients released before kinds.
const preKindListOutputSchema = skillsListOutputSchema.extend({
  skills: z.array(listedSkillSchema.omit({ kind: true }).strict()).max(100),
});
const preKindSearchOutputSchema = skillsSearchOutputSchema.extend({
  skills: z.array(skillSearchItemSchema.omit({ kind: true }).strict()).max(100),
});

function decodeJson(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function encodeJson(value: unknown): string {
  return Buffer.from(stableJson(value)).toString("base64url");
}

// Re-signs a skills_list cursor whose page cursor carries no kind, as every
// cursor issued before artifact kinds did.
function withoutKind(cursor: string, secret: string): string {
  const envelope = decodeJson(cursor.split(".")[0] ?? "");
  const page = decodeJson(
    String((envelope.boundary as { pageCursor: string }).pageCursor),
  );
  expect(page.kind).toBe("skill");
  delete page.kind;
  const body = encodeJson({ ...envelope, boundary: { pageCursor: encodeJson(page) } });
  const signature = createHmac("sha256", secret)
    .update(Buffer.from(body, "base64url"))
    .digest("base64url");
  return `${body}.${signature}`;
}

// Re-signs a search cursor with the filter hash a pre-kind deployment issued,
// after checking that the current hash binds the all-kinds marker.
function preKindSearchCursor(
  cursor: string,
  secret: string,
  filters: Record<string, unknown>,
): string {
  const hash = (value: unknown) =>
    createHash("sha256").update(stableJson(value)).digest("base64url");
  const payload = decodeJson(cursor.split(".")[0] ?? "");
  expect(payload.filterHash).toBe(hash({ ...filters, kind: "*" }));
  const body = encodeJson({ ...payload, filterHash: hash(filters) });
  const signature = createHmac("sha256", secret)
    .update(Buffer.from(body, "base64url"))
    .digest("base64url");
  return `${body}.${signature}`;
}

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

    const agentUses = async () =>
      (
        await environment.services.database.pool.query<{ uses: string }>(
          `SELECT COALESCE(sum(agent_skill_uses), 0)::text AS uses
             FROM public_stats_counters WHERE id = $1`,
          [environment.owner.workspaceId],
        )
      ).rows[0]?.uses;
    const usesBefore = await agentUses();
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
    // The combined-database counter trigger reads the persisted flag.
    expect(await agentUses()).toBe(usesBefore);
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
    expect(await agentUses()).toBe(String(Number(usesBefore) + 1));

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
          kind: "instructions",
          limit: 100,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(listed.skills.find((item) => item.id === created.skill.id)?.kind).toBe(
      "instructions",
    );

    const searched = parseStructured<SkillsSearchOutput>(
      await oauth.client.callTool({
        name: "skills_search",
        arguments: {
          workspace: { id: environment.owner.workspaceId },
          query: "repository agents",
          kind: "instructions",
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
  it("lists and searches only skills unless a caller selects instructions", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const term = `kindfilter${suffix}`;
    const createArtifact = async (kind: "skill" | "instructions", index: number) =>
      parseStructured<SkillCreateOutput>(
        await oauth.client.callTool({
          name: "skill_create",
          arguments: {
            workspace: { id: environment.owner.workspaceId },
            kind,
            slug: `${kind}-${index}-${suffix}`,
            name: `Kind filter ${kind} ${index}`,
            description: `Shared ${term} guidance`,
            visibility: "workspace",
            instructions: `# ${term}\n\nFollow the ${kind} guidance.\n`,
            idempotencyKey: `kind-filter-${kind}-${index}-${suffix}`,
            caller: TEST_CALLER,
          },
        }),
      ).skill.id;
    const instructionIds = [
      await createArtifact("instructions", 1),
      await createArtifact("instructions", 2),
    ];
    const skillId = await createArtifact("skill", 1);
    const workspace = { id: environment.owner.workspaceId };

    // A caller that sends no kind gets the pre-kind shape a strict client parses.
    const defaultList = preKindListOutputSchema.parse(
      (
        await oauth.client.callTool({
          name: "skills_list",
          arguments: { workspace, limit: 100, caller: TEST_CALLER },
        })
      ).structuredContent,
    );
    const defaultListIds = defaultList.skills.map((item) => item.id);
    expect(defaultListIds).toContain(skillId);
    expect(defaultListIds).not.toContain(instructionIds[0]);
    const defaultSearch = preKindSearchOutputSchema.parse(
      (
        await oauth.client.callTool({
          name: "skills_search",
          arguments: { workspace, query: term, caller: TEST_CALLER },
        })
      ).structuredContent,
    );
    expect(defaultSearch.skills.map((item) => item.id)).toEqual([skillId]);

    for (const name of ["skills_list", "skills_search"] as const) {
      const query = name === "skills_search" ? { query: term } : {};
      const seen: string[] = [];
      let cursor: string | null = null;
      let firstCursor: string | null = null;
      do {
        const page: SkillsListOutput | SkillsSearchOutput = parseStructured(
          await oauth.client.callTool({
            name,
            arguments: {
              workspace,
              ...query,
              kind: "instructions",
              cursor,
              limit: 1,
              caller: TEST_CALLER,
            },
          }),
        );
        for (const item of page.skills) {
          expect(item.kind, name).toBe("instructions");
          seen.push(item.id);
        }
        cursor = page.nextCursor;
        firstCursor ??= cursor;
      } while (cursor);
      expect(seen, name).toEqual(expect.arrayContaining(instructionIds));
      expect(seen, name).not.toContain(skillId);

      // A cursor stays bound to the kind it was issued for.
      expect(firstCursor, name).not.toBeNull();
      const replayed = await oauth.client.callTool({
        name,
        arguments: {
          workspace,
          ...query,
          kind: "skill",
          cursor: firstCursor,
          limit: 1,
          caller: TEST_CALLER,
        },
      });
      expect(parseToolError(replayed).error.code, name).toBe("CURSOR_FILTER_MISMATCH");

      const malformed = await oauth.client.callTool({
        name,
        arguments: { workspace, ...query, kind: "agents", caller: TEST_CALLER },
      });
      // Schema validation rejects an unknown kind before the handler runs.
      expect(parseToolError(malformed).error.code, name).toBe(
        "MCPFN_INVALID_ARGUMENTS",
      );
    }
  });

  it("continues skill cursors issued before artifact kinds", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const term = `prekind${suffix}`;
    const workspace = { id: environment.owner.workspaceId };
    for (const [kind, index] of [
      ["skill", 1],
      ["skill", 2],
      ["instructions", 1],
    ] as const)
      await oauth.client.callTool({
        name: "skill_create",
        arguments: {
          workspace,
          kind,
          slug: `prekind-${kind}-${index}-${suffix}`,
          name: `Pre-kind ${kind} ${index}`,
          description: `Shared ${term} guidance`,
          visibility: "workspace",
          instructions: `# ${term}\n\nFollow the ${kind} guidance.\n`,
          idempotencyKey: `prekind-${kind}-${index}-${suffix}`,
          caller: TEST_CALLER,
        },
      });

    const first = parseStructured<SkillsListOutput>(
      await oauth.client.callTool({
        name: "skills_list",
        arguments: { workspace, limit: 1, caller: TEST_CALLER },
      }),
    );
    const listCursor = withoutKind(
      String(first.nextCursor),
      environment.services.tenancySecret,
    );
    const owner = environment.owner;
    const search = await environment.services.skillSearchService.search({
      query: term,
      workspaceId: owner.workspaceId,
      tags: [],
      visibility: ["private", "workspace", "public"],
      archive: "active",
      limit: 1,
      principal: {
        kind: "user",
        actorId: owner.userId,
        userId: owner.userId,
        sessionId: "fixture:prekind",
        workspaceId: owner.workspaceId,
        role: "owner",
      },
    });
    // The service mints an all-kinds cursor, which never continues the
    // default skills-only search.
    const allKinds = await oauth.client.callTool({
      name: "skills_search",
      arguments: {
        workspace,
        query: term,
        cursor: String(search.nextCursor),
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(allKinds).error.code).toBe("CURSOR_FILTER_MISMATCH");
    const searchCursor = preKindSearchCursor(
      String(search.nextCursor),
      environment.services.tenancySecret,
      {
        query: term,
        tags: [],
        visibility: ["private", "public", "workspace"],
        archive: "active",
        scope: `workspace:${owner.workspaceId}`,
      },
    );

    for (const [name, cursor, query, schema] of [
      ["skills_list", listCursor, {}, preKindListOutputSchema],
      ["skills_search", searchCursor, { query: term }, preKindSearchOutputSchema],
    ] as const) {
      const continued = schema.parse(
        (
          await oauth.client.callTool({
            name,
            arguments: { workspace, ...query, cursor, limit: 100, caller: TEST_CALLER },
          })
        ).structuredContent,
      );
      expect(continued.skills.length, name).toBeGreaterThan(0);
      // A pre-kind cursor never continues an instructions listing.
      const replayed = await oauth.client.callTool({
        name,
        arguments: {
          workspace,
          ...query,
          kind: "instructions",
          cursor,
          caller: TEST_CALLER,
        },
      });
      expect(parseToolError(replayed).error.code, name).toBe("CURSOR_FILTER_MISMATCH");
    }
  });
  it("rejects blank or oversized documents on create as caller validation errors", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    for (const kind of ["skill", "instructions"] as const)
      for (const [label, instructions, assets] of [
        ["blank", " \n\t\n", []],
        ["oversized", "x".repeat(2 * 1024 * 1024), []],
        ...(kind === "instructions"
          ? ([["assets", "# Agents\n", [{ path: "notes.md", content: "x" }]]] as const)
          : []),
      ] as const) {
        const rejected = await oauth.client.callTool({
          name: "skill_create",
          arguments: {
            workspace: { id: environment.owner.workspaceId },
            kind,
            slug: `invalid-${kind}-${label}-${suffix}`,
            name: "Invalid document",
            instructions,
            assets,
            idempotencyKey: `invalid-${kind}-${label}-${suffix}`,
            caller: TEST_CALLER,
          },
        });
        expect(parseToolError(rejected).error, `${kind} ${label}`).toMatchObject({
          code: "VALIDATION_FAILED",
          retryable: false,
        });
      }
  });
});
