import { describe, expect, it } from "vitest";
import { createSkillplaneAuthFnMultiRegionConfig } from "./multi-region.js";

describe("Skillplane AuthFn multi-region runtime", () => {
  it("terminates the co-located global identity authority directly", () => {
    const config = createSkillplaneAuthFnMultiRegionConfig({
      issuer: "https://app.skillplane.dev",
      resource: "https://mcp.skillplane.dev/mcp",
    });
    expect(config.defaultRegionId).toBe("global");
    expect(config.routing).toMatchObject({
      mode: "direct",
      publicAuthority: "https://app.skillplane.dev",
      canonicalOAuth: { resource: "https://mcp.skillplane.dev/mcp" },
    });
  });
});
