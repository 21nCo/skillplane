import { describe, expect, it } from "vitest";
import { maskedEmail } from "./authorization.js";
import { OAUTH_SCOPES, OAUTH_SCOPE_DESCRIPTIONS } from "./config.js";

describe("OAuth consent presentation", () => {
  it("provides action-specific copy for every supported scope", () => {
    expect(Object.keys(OAUTH_SCOPE_DESCRIPTIONS)).toEqual([...OAUTH_SCOPES]);
    expect(OAUTH_SCOPE_DESCRIPTIONS["skills:write"]).toContain("Create skills");
    expect(OAUTH_SCOPE_DESCRIPTIONS["skills:write"]).toContain("skill records");
    expect(OAUTH_SCOPE_DESCRIPTIONS["skills:read"]).toContain("unpublished proposals");
    expect(OAUTH_SCOPE_DESCRIPTIONS["skills:publish"]).toContain("Approve");
    expect(OAUTH_SCOPE_DESCRIPTIONS["skills:publish"]).toContain("publish");
    expect(OAUTH_SCOPE_DESCRIPTIONS["skills:publish"]).toContain("amendment policies");
    expect(OAUTH_SCOPE_DESCRIPTIONS["contexts:write"]).toContain(
      "archive or restore contexts",
    );
  });

  it("identifies an account without disclosing its full email address", () => {
    expect(maskedEmail("alice@example.test")).toBe("al•••@example.test");
    expect(maskedEmail("a@example.test")).toBe("a•••@example.test");
    expect(maskedEmail(null)).toBe("Signed-in Skillplane account");
    expect(maskedEmail("invalid")).toBe("Signed-in Skillplane account");
  });
});
