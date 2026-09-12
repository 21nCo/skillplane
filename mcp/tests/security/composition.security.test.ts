import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalizeBundleFiles } from "@skillplane/storage";
import { skillResolveOutputSchema } from "@skillplane/mcp-schema";
import {
  startMcpTestEnvironment,
  parseStructured,
  TEST_CALLER,
  type McpTestEnvironment,
  type ConnectedMcpClient,
} from "../support/mcp-test-environment.js";
let environment: McpTestEnvironment;
let client: ConnectedMcpClient;
let skillId: string;
let versionId: string;
beforeAll(async () => {
  environment = await startMcpTestEnvironment("composition");
  client = await environment.connect(environment.skillsOnlyToken);
  const workspace = await environment.services.controlDatabase.pool.query<{
    slug: string;
  }>("SELECT slug FROM workspaces WHERE id=$1", [environment.owner.workspaceId]);
  const claims = [
    {
      id: "complete-inventory",
      statement: "Every read surface accounted for",
      severity: "blocking",
      scope: "Repository",
      requiredEvidence: ["inventory", "runtime"],
      prohibitedBypasses: ["direct-db"],
      rules: {
        pass: "All surfaces traced",
        fail: "A bypass exists",
        unknown: "A surface is unaccounted for",
      },
    },
  ];
  const bundle = await canonicalizeBundleFiles({
    skill: {
      formatVersion: 2,
      name: "MCP composition",
      slug: "mcp-composition",
      description: "Integration fixture",
      tags: [],
      entrypoints: { execute: "SKILL.md", verify: "verification/VERIFY.md" },
      dependencies: [
        {
          alias: "leaf",
          workspace: workspace.rows[0]?.slug ?? "missing",
          skill: environment.skill.skill.slug,
          version: "*",
          scope: "execution",
          mode: "invoke",
          required: true,
        },
      ],
      verification: { claims: "verification/claims.json", blocking: true },
    },
    files: new Map([
      ["SKILL.md", new TextEncoder().encode("Execute through the leaf handoff")],
      [
        "verification/VERIFY.md",
        new TextEncoder().encode("Independently trace all read paths"),
      ],
      ["verification/claims.json", new TextEncoder().encode(JSON.stringify(claims))],
    ]),
  });
  const created = await environment.services.skillService.create({
    workspaceId: environment.owner.workspaceId,
    principal: {
      kind: "user",
      actorId: environment.owner.userId,
      userId: environment.owner.userId,
      sessionId: "fixture",
      workspaceId: environment.owner.workspaceId,
      role: "owner",
    },
    archiveBytes: bundle.bytes,
    visibility: "private",
    idempotencyKey: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
  });
  skillId = created.skill.id;
  versionId = created.version.id;
}, 60000);
afterAll(async () => {
  await environment?.close();
});
describe("native composition through authenticated MCP", () => {
  it("returns structured modules and enforces independent evidence-backed attestation", async () => {
    const selector = {
      skill: { id: skillId },
      version: { selector: "versionId", versionId },
      caller: TEST_CALLER,
    };
    const executed = await client.client.callTool({
      name: "skill_resolve",
      arguments: selector,
    });
    expect(executed.isError, JSON.stringify(executed)).not.toBe(true);
    const plan = skillResolveOutputSchema.parse(parseStructured(executed)).plan;
    expect(plan.dag.nodes).toHaveLength(1);
    expect(plan.executionPlan.invocations).toHaveLength(1);
    const verified = await client.client.callTool({
      name: "skill_verification_plan_get",
      arguments: selector,
    });
    expect(verified.isError).not.toBe(true);
    const verificationPlan = skillResolveOutputSchema.parse(
      parseStructured(verified),
    ).plan;
    expect(verificationPlan.executionPlan.modules).toHaveLength(0);
    expect(verificationPlan.verificationPlan.claims).toHaveLength(1);
    const started = await client.client.callTool({
      name: "skill_verification_run_start",
      arguments: {
        ...selector,
        repository: "https://example.com/repository",
        commit: "a".repeat(40),
        environment: "test",
        executorActorId: "executor:other",
        agent: "independent-verifier",
        model: "test-model",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(started.isError, JSON.stringify(started)).not.toBe(true);
    const run = parseStructured<{ result: { id: string } }>(started).result;
    const incomplete = await client.client.callTool({
      name: "skill_verification_evidence_add",
      arguments: {
        skill: { id: skillId },
        runId: run.id,
        caller: TEST_CALLER,
        idempotencyKey: crypto.randomUUID(),
        result: {
          claimId:
            verificationPlan.verificationPlan.claims[0]?.namespacedId ?? "missing",
          status: "pass",
          explanation: "Only scaffolding exists",
          evidence: [],
        },
      },
    });
    expect(incomplete.isError).toBe(true);
    const completionArgs = {
      skill: { id: skillId },
      runId: run.id,
      caller: TEST_CALLER,
      idempotencyKey: crypto.randomUUID(),
    };
    const completed = await client.client.callTool({
      name: "skill_verification_run_complete",
      arguments: completionArgs,
    });
    expect(completed.isError, JSON.stringify(completed)).not.toBe(true);
    expect(
      parseStructured<{ result: { status: string } }>(completed).result.status,
    ).toBe("unknown");
    const replay = await client.client.callTool({
      name: "skill_verification_run_complete",
      arguments: completionArgs,
    });
    expect(parseStructured(replay)).toMatchObject({
      result: { id: run.id, status: "unknown" },
    });
  });
});
