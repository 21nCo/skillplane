import { describe, it, expect } from "vitest";
import { canonicalizeBundleFiles, canonicalizeBundle } from "./canonicalize.js";
import { verificationClaimsSchema } from "./composition.js";
const skill = {
  formatVersion: 2 as const,
  name: "Composite",
  slug: "composite",
  description: "",
  tags: [],
  entrypoints: {
    execute: "SKILL.md" as const,
    verify: "verification/VERIFY.md" as const,
  },
  dependencies: [],
  verification: { claims: "verification/claims.json" as const, blocking: true },
};
const claim = {
  id: "read-surfaces",
  statement: "All reads use DataFn",
  severity: "blocking",
  scope: "Every application read",
  requiredEvidence: ["inventory", "runtime-traces"],
  prohibitedBypasses: ["direct SQL"],
  rules: {
    pass: "Every surface accounted for",
    fail: "A bypass is found",
    unknown: "A surface is unaccounted for",
  },
};
const files = () =>
  new Map([
    ["SKILL.md", new TextEncoder().encode("Execute")],
    [
      "verification/VERIFY.md",
      new TextEncoder().encode(
        "Inventory all reads and mutations; check runtime traces",
      ),
    ],
    ["verification/claims.json", new TextEncoder().encode(JSON.stringify([claim]))],
  ]);
describe("format-v2 bundles", () => {
  it("round trips canonically with verifier files", async () => {
    const bundle = await canonicalizeBundleFiles({ skill, files: files() });
    expect(bundle.manifest.formatVersion).toBe(2);
    expect((await canonicalizeBundle(bundle.bytes)).digest).toBe(bundle.digest);
  });
  it("does not admit verification files in v1", async () => {
    await expect(
      canonicalizeBundleFiles({
        skill: {
          formatVersion: 1,
          name: "Leaf",
          slug: "leaf",
          description: "",
          tags: [],
          entrypoint: "SKILL.md",
        },
        files: files(),
      }),
    ).rejects.toThrow("require format version 2");
  });
  it("rejects missing verifier entrypoint, missing claim procedures and duplicate claim IDs", async () => {
    const missing = files();
    missing.delete("verification/VERIFY.md");
    await expect(canonicalizeBundleFiles({ skill, files: missing })).rejects.toThrow();
    const procedure = files();
    procedure.set(
      "verification/claims.json",
      new TextEncoder().encode(
        JSON.stringify([{ ...claim, procedure: "verification/missing.md" }]),
      ),
    );
    await expect(
      canonicalizeBundleFiles({ skill, files: procedure }),
    ).rejects.toThrow();
    expect(verificationClaimsSchema.safeParse([claim, claim]).success).toBe(false);
  });
});
