import { describe, expect, it, vi } from "vitest";
import {
  createPostgresAuthFnPlacementDirectory,
  createSkillplaneAuthFnMultiRegionConfig,
} from "./multi-region.js";

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

  it("rejects a compare-and-set payload for a different identity", async () => {
    const query = vi.fn();
    const directory = createPostgresAuthFnPlacementDirectory({ query } as never);

    await expect(
      directory.compareAndSet({
        identityKey: "identity:expected",
        expectedEpoch: 1,
        expectedState: "active",
        placement: {
          identityKey: "identity:other",
          regionId: "global",
          epoch: 2,
          state: "active",
          updatedAt: new Date(),
        },
      }),
    ).rejects.toThrow("AUTHFN_PLACEMENT_IDENTITY_MISMATCH");
    expect(query).not.toHaveBeenCalled();
  });
});
