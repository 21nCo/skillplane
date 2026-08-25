import { describe, expect, it, vi } from "vitest";
import { readPublicStats } from "./public-stats.js";

describe("public statistics", () => {
  it("preserves valid bigint counts as exact decimal strings", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          total_skills: "9007199254740992",
          agent_skill_uses: "18446744073709551615",
        },
      ],
    });

    await expect(readPublicStats({ query } as never)).resolves.toEqual({
      totalSkills: "9007199254740992",
      agentSkillUses: "18446744073709551615",
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("public_stats_counters");
    expect(query.mock.calls[0]?.[0]).not.toContain("audit_events");
  });

  it("rejects malformed or negative database counts", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ total_skills: "-1", agent_skill_uses: "0" }],
    });

    await expect(readPublicStats({ query } as never)).rejects.toThrow(
      "Public statistics returned an invalid count",
    );
  });
});
