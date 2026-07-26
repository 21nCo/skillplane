import { describe, expect, it } from "vitest";
import { app } from "./index.js";

describe("MCP OAuth discovery", () => {
  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])(
    "serves protected-resource metadata at %s without database startup",
    async (path) => {
      const response = await app.request(path);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        resource: "https://mcp.skillplane.dev/mcp",
        authorization_servers: ["https://app.skillplane.dev"],
        bearer_methods_supported: ["header"],
      });
    },
  );
});
