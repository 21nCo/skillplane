import type { SkillCreateOutput } from "@skillplane/mcp-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseStructured,
  startMcpTestEnvironment,
  TEST_CALLER,
  type ConnectedMcpClient,
  type McpTestEnvironment,
} from "../support/mcp-test-environment.js";

let environment: McpTestEnvironment;
let oauth: ConnectedMcpClient;

beforeAll(async () => {
  environment = await startMcpTestEnvironment("resource-routing");
  oauth = await environment.connect(
    await environment.issueOAuthToken("skills:read skills:write"),
  );
}, 60_000);

afterAll(async () => {
  await environment.close();
}, 30_000);

describe("MCP resource route convergence", () => {
  it("registers skill and version IDs and repairs them on idempotent replay", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const createArguments = {
      workspace: { id: environment.owner.workspaceId },
      slug: `routing-${suffix}`,
      name: "Routing fixture",
      description: "Proves MCP-created IDs can enter through the global gateway",
      tags: ["routing"],
      visibility: "private",
      instructions: "# Routing fixture\n\nResolve this skill by ID.\n",
      assets: [],
      idempotencyKey: `skill-routing-${suffix}`,
      caller: TEST_CALLER,
    } as const;
    const created = parseStructured<SkillCreateOutput>(
      await oauth.client.callTool({ name: "skill_create", arguments: createArguments }),
    );
    const routes = () =>
      environment.services.controlDatabase.pool.query<{
        resource_type: string;
        resource_id: string;
        workspace_id: string;
      }>(
        `SELECT resource_type, resource_id, workspace_id
           FROM resource_routing_directory
          WHERE (resource_type, resource_id) IN
                (('skill', $1), ('skill_version', $2))
            AND state = 'active'
          ORDER BY resource_type`,
        [created.skill.id, created.version.id],
      );
    await expect(routes()).resolves.toMatchObject({
      rows: [
        {
          resource_type: "skill",
          resource_id: created.skill.id,
          workspace_id: environment.owner.workspaceId,
        },
        {
          resource_type: "skill_version",
          resource_id: created.version.id,
          workspace_id: environment.owner.workspaceId,
        },
      ],
    });
    const durable = await environment.services.database.pool.query<{
      payload: { resources?: readonly { resourceId?: string }[] };
    }>(
      `SELECT payload
         FROM regional_projection_outbox
        WHERE workspace_id = $1 AND event_type = 'resource_route.upsert'
          AND payload->'resources' @> $2::jsonb
        ORDER BY sequence DESC
        LIMIT 1`,
      [
        environment.owner.workspaceId,
        JSON.stringify([{ resourceType: "skill", resourceId: created.skill.id }]),
      ],
    );
    expect(durable.rows[0]?.payload.resources).toEqual(
      expect.arrayContaining([
        { resourceType: "skill", resourceId: created.skill.id },
        { resourceType: "skill_version", resourceId: created.version.id },
      ]),
    );

    await environment.services.controlDatabase.pool.query(
      `DELETE FROM resource_routing_directory
        WHERE (resource_type, resource_id) IN
              (('skill', $1), ('skill_version', $2))`,
      [created.skill.id, created.version.id],
    );
    const replay = parseStructured<SkillCreateOutput>(
      await oauth.client.callTool({ name: "skill_create", arguments: createArguments }),
    );

    expect(replay.skill.id).toBe(created.skill.id);
    await expect(routes()).resolves.toMatchObject({
      rows: [
        { resource_type: "skill", workspace_id: environment.owner.workspaceId },
        {
          resource_type: "skill_version",
          workspace_id: environment.owner.workspaceId,
        },
      ],
    });
  });
});
