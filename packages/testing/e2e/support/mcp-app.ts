import { register } from "node:module";

/**
 * The MCP Worker imports its icons as binary modules, which Wrangler bundles
 * as ArrayBuffers. Node has no loader for them, so map them to empty buffers:
 * the browser tests only call `/mcp`, never the icon routes.
 */
const binaryAssetLoader = `
const emptyBuffer = "data:text/javascript,export%20default%20new%20ArrayBuffer(0)%3B";
export async function resolve(specifier, context, nextResolve) {
  if (/\\.(?:png|ico)$/u.test(specifier)) {
    return { url: emptyBuffer, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;

let registered = false;

export type McpFetch = (request: Request) => Promise<Response>;

/** Builds the real MCP app over the harness's API services. */
export async function createHarnessMcpApp(
  getServices: () => Promise<unknown>,
): Promise<McpFetch> {
  if (!registered) {
    register(`data:text/javascript,${encodeURIComponent(binaryAssetLoader)}`);
    registered = true;
  }
  const { createMcpApp } = await import("../../../../mcp/src/index.js");
  const app = createMcpApp({
    getServices: getServices as NonNullable<
      Parameters<typeof createMcpApp>[0]
    >["getServices"],
    posthog: null,
  });
  return async (request) => await app.fetch(request);
}
