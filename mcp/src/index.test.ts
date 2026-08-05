import { describe, expect, it } from "vitest";
import { app } from "./index.js";
import { SKILLPLANE_MCP_SERVER_INFO } from "./server.js";

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

  it("publishes the Skillplane identity for MCP clients", () => {
    expect(SKILLPLANE_MCP_SERVER_INFO).toMatchObject({
      name: "skillplane",
      title: "Skillplane",
      websiteUrl: "https://skillplane.dev",
      icons: [
        {
          src: "https://mcp.skillplane.dev/icon-192.png",
          mimeType: "image/png",
          sizes: ["192x192"],
        },
        {
          src: "https://mcp.skillplane.dev/icon-512.png",
          mimeType: "image/png",
          sizes: ["512x512"],
        },
      ],
    });
  });

  it.each([
    ["/favicon.ico", "image/x-icon"],
    ["/favicon-32x32.png", "image/png"],
    ["/apple-touch-icon.png", "image/png"],
    ["/icon-192.png", "image/png"],
    ["/icon-512.png", "image/png"],
    ["/skillplane-logo-gradient-transparent.png", "image/png"],
  ])("serves the branded asset at %s", async (path, contentType) => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(contentType);
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it("links favicon discovery from the MCP origin", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toContain('href="/favicon.ico"');
  });

  it("renders the gradient logo on the MCP landing page", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain(
      'src="/skillplane-logo-gradient-transparent.png"',
    );
  });
});
