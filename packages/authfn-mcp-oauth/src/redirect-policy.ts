import type { McpFnRedirectPolicy } from "@mcpfn/auth";

export const SKILLPLANE_MCP_REDIRECT_POLICY = {
  allowDynamicLoopbackPort: true,
  allowLocalhostLoopback: true,
} as const satisfies McpFnRedirectPolicy;
