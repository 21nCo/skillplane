import { describe, expect, it, vi } from "vitest";
import { ALL_SKILLS_ROLLUP_ID } from "./rollups.js";
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
    expect(query).toHaveBeenCalledWith(expect.any(String), [ALL_SKILLS_ROLLUP_ID]);
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
