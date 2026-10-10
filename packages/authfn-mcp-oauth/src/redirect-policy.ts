import type { McpFnRedirectPolicy } from "@mcpfn/auth";

export const SKILLPLANE_MCP_REDIRECT_POLICY = {
  allowDynamicLoopbackPort: true,
  allowLocalhostLoopback: true,
  privateUseSchemePolicy: "compatible",
  compatiblePrivateUseSchemes: ["cursor"],
} as const satisfies McpFnRedirectPolicy;
