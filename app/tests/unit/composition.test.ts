import { describe, it, expect } from "vitest";
import {
  buildSkillBundle,
  filesFromBundle,
  inspectSkillBundle,
} from "../../src/lib/skills/bundle.js";
const metadata = { name: "Composite", slug: "composite", description: "", tags: [] };
describe("composition authoring bundles", () => {
  it("keeps v2 dependencies and verification metadata when editing instructions", async () => {
    const dependencies = [
      {
        alias: "data",
        workspace: "examples",
        skill: "use-datafn",
        version: "^1.0.0",
        scope: "both",
        mode: "invoke",
        required: true,
      },
    ];
    const initial = await buildSkillBundle({
      metadata,
      composition: { dependencies, verify: true, blocking: true },
      files: new Map([
        ["SKILL.md", new TextEncoder().encode("Before")],
        ["verification/VERIFY.md", new TextEncoder().encode("Verify")],
        ["verification/claims.json", new TextEncoder().encode("[]")],
      ]),
    });
    const files = new Map(filesFromBundle(initial));
    files.set("SKILL.md", new TextEncoder().encode("After"));
    const edited = await buildSkillBundle({ metadata, files });
    const skill = JSON.parse(
      new TextDecoder().decode(filesFromBundle(edited).get("skill.json")),
    );
    expect(skill).toMatchObject({
      formatVersion: 2,
      dependencies,
      verification: { blocking: true },
      entrypoints: { verify: "verification/VERIFY.md" },
    });
    expect(inspectSkillBundle(edited).formatVersion).toBe(2);
  });
});
