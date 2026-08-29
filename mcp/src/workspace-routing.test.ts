import { describe, expect, it } from "vitest";
import { classifyMcpScope } from "./workspace-routing.js";

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
  });

  it("rejects mixed-workspace batches", async () => {
    const request = new Request("https://mcp.skillplane.dev/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "skills_search",
            arguments: { workspaceId: "workspace:one" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "skills_search",
            arguments: { workspaceId: "workspace:two" },
          },
        },
      ]),
    });
    await expect(classifyMcpScope(request)).rejects.toMatchObject({
      code: "WORKSPACE_BATCH_INVALID",
    });
  });
});
