import { describe, expect, it } from "vitest";
import { createSkillplaneAuthFnMultiRegionConfig } from "./multi-region.js";

describe("Skillplane AuthFn canonical gateway runtime", () => {
  it("uses the durable global placement directory in gateway mode", async () => {
    const queries: string[] = [];
    const pool = {
      async query(text: string) {
        queries.push(text);
        return { rows: [{ primary_email: "owner@example.test" }] };
      },
    };
    const config = createSkillplaneAuthFnMultiRegionConfig({
      pool: pool as never,
      issuer: "https://app.skillplane.dev",
      resource: "https://mcp.skillplane.dev/mcp",
      activeRoutingKeyId: "current",
      routingKeys: { current: "independent-routing-secret-000000000000" },
    });
    expect(config.routing?.mode).toBe("gateway");
    if (config.routing?.mode !== "gateway") throw new Error("gateway expected");
    expect(config.routing.identityKeyForIdentifier(" OWNER@EXAMPLE.TEST ")).toBe(
      "identifier:owner@example.test",
    );
    await expect(config.routing.identityKeyForUserId("user:one")).resolves.toBe(
      "identifier:owner@example.test",
    );
    expect(queries[0]).toContain("FROM authfn_users");
  });
});
