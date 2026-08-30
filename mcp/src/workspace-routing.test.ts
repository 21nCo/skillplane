import { describe, expect, it } from "vitest";
import { classifyMcpScope, resolveMcpWorkspaceBatch } from "./workspace-routing.js";

function call(name: string, arguments_: Record<string, unknown> = {}) {
  return new Request("https://mcp.skillplane.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
}

function batch(...calls: { readonly name: string; readonly arguments: object }[]) {
  return new Request("https://mcp.skillplane.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      calls.map((entry, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: entry,
      })),
    ),
  });
}

function services(routes: Readonly<Record<string, string>>) {
  return {
    controlDatabase: {
      pool: {
        query: async (_text: string, values: readonly unknown[]) => ({
          rows: [
            {
              resource_type: "skill",
              resource_id: values[1],
              workspace_id: routes[String(values[1])],
              state: "active",
              updated_at: new Date("2026-08-30T00:00:00.000Z"),
            },
          ],
        }),
      },
    },
  } as never;
}

describe("MCP workspace routing", () => {
  it("keeps protocol and workspace catalog operations global", async () => {
    await expect(classifyMcpScope(call("workspaces_list"))).resolves.toEqual({
      kind: "global",
    });
  });

  it("routes workspace and skill selectors without exposing cell hosts", async () => {
    await expect(
      classifyMcpScope(call("skills_list", { workspace: { slug: "acme" } })),
    ).resolves.toEqual({
      kind: "workspace-slug",
      value: "acme",
      allowPublic: false,
    });
    await expect(
      classifyMcpScope(call("skill_retrieve", { skill: { id: "skill:one" } })),
    ).resolves.toEqual({
      kind: "skill-id",
      value: "skill:one",
      allowPublic: true,
    });
    await expect(
      classifyMcpScope(call("skill_amend", { skillId: "skill:one" })),
    ).resolves.toEqual({
      kind: "skill-id",
      value: "skill:one",
      allowPublic: false,
    });
  });

  it("routes credential-bound downloads through the owning cell", async () => {
    await expect(
      classifyMcpScope(
        new Request("https://mcp.skillplane.dev/downloads/signed-grant"),
      ),
    ).resolves.toEqual({
      kind: "download-grant",
      token: "signed-grant",
      allowPublic: true,
    });
  });

  it("rejects mixed-workspace batches", async () => {
    const scope = await classifyMcpScope(
      batch(
        { name: "skill_retrieve", arguments: { skillId: "skill:one" } },
        { name: "skill_retrieve", arguments: { skillId: "skill:two" } },
      ),
    );
    if (scope.kind === "global") throw new Error("Expected a workspace batch");
    await expect(
      resolveMcpWorkspaceBatch(
        scope,
        services({
          "skill:one": "workspace:one",
          "skill:two": "workspace:two",
        }),
      ),
    ).rejects.toMatchObject({
      code: "WORKSPACE_BATCH_INVALID",
    });
  });

  it("accepts different resource selectors that resolve to one workspace", async () => {
    const scope = await classifyMcpScope(
      batch(
        { name: "skill_retrieve", arguments: { skillId: "skill:one" } },
        { name: "skill_versions_list", arguments: { skillId: "skill:two" } },
      ),
    );
    if (scope.kind === "global") throw new Error("Expected a workspace batch");
    await expect(
      resolveMcpWorkspaceBatch(
        scope,
        services({
          "skill:one": "workspace:one",
          "skill:two": "workspace:one",
        }),
      ),
    ).resolves.toMatchObject({ workspaceId: "workspace:one" });
  });
});
