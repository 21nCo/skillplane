import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PRODUCT_CAPABILITIES,
  SECURITY_PRACTICES,
  TRUTHFUL_PRODUCT_CLAIMS,
  WORKFLOW_STEPS,
} from "../../src/lib/content.js";
import { publicSkillFilePath, publicSkillPath } from "../../src/lib/public-skills.js";

const landingRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("landing content contract", () => {
  it("describes the implemented controlled-learning workflow", () => {
    expect(WORKFLOW_STEPS.map((step) => step.title)).toEqual([
      "Create",
      "Contextualize",
      "Retrieve",
      "Amend",
      "Review",
      "Publish",
    ]);
    expect(PRODUCT_CAPABILITIES.map((feature) => feature.title)).toEqual(
      expect.arrayContaining([
        "Versioned by design",
        "Context without copies",
        "MCP-native access",
        "Caller provenance",
        "Controlled learning",
        "Auditable operations",
      ]),
    );
    expect(SECURITY_PRACTICES).toEqual(
      expect.arrayContaining([
        expect.stringContaining("workspace-scoped permissions"),
        expect.stringContaining("Private responses marked no-store"),
      ]),
    );
    expect(TRUTHFUL_PRODUCT_CLAIMS).toHaveLength(4);
  });

  it("contains no unsupported commerce or incomplete-product claims", async () => {
    const files = [
      "src/routes/+page.svelte",
      "src/lib/components/Hero.svelte",
      "src/lib/components/Workflow.svelte",
      "src/lib/components/FeatureGrid.svelte",
      "src/lib/components/Security.svelte",
      "src/lib/components/Footer.svelte",
      "src/routes/skills/+page.svelte",
    ];
    const copy = (
      await Promise.all(
        files.map((file) => readFile(resolve(landingRoot, file), "utf8")),
      )
    ).join("\n");
    expect(copy).not.toMatch(
      /\b(?:pricing|buy now|checkout|payout|seller fees|coming soon|in progress)\b/iu,
    );
    expect(copy).toContain("Complete provenance");
    expect(copy).toContain("Candidate versions, context");
  });

  it("builds encoded public page and immutable digest file paths", () => {
    expect(publicSkillPath("Acme Space", "pr/review")).toBe(
      "/skills/Acme%20Space/pr%2Freview",
    );
    expect(
      publicSkillFilePath({
        workspaceSlug: "acme",
        skillSlug: "pr-review",
        versionId: "skill-version:1",
        digest: `sha256:${"a".repeat(64)}`,
        path: "references/check list.md",
      }),
    ).toBe(
      `/api/v1/skills/public/acme/pr-review/versions/skill-version%3A1/sha256%3A${"a".repeat(
        64,
      )}/files/references/check%20list.md`,
    );
  });
});
