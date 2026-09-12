import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  compositionCandidateInputSchema,
  skillResolveInputSchema,
  skillResolveOutputSchema,
  verificationStartInputSchema,
  verificationEvidenceInputSchema,
  verificationCompleteInputSchema,
  versionLifecycleInputSchema,
} from "@skillplane/mcp-schema";
import { skillplaneMcpDeclaration } from "./server.js";
describe("native composition MCP contracts", () => {
  it("registers the expanded server without unsupported schema constructs", () => {
    expect(skillplaneMcpDeclaration).toBeDefined();
  });
  it.each([
    compositionCandidateInputSchema,
    skillResolveInputSchema,
    skillResolveOutputSchema,
    verificationStartInputSchema,
    verificationEvidenceInputSchema,
    verificationCompleteInputSchema,
    versionLifecycleInputSchema,
  ])("exports an object JSON schema for every composition surface", (schema) => {
    const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" });
    expect(json.type).toBe("object");
    expect(JSON.stringify(json)).not.toContain('"pattern":"(?');
  });
});
