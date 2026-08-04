import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const specifications = [
  "packages/ui/tests/a11y/workbench.spec.ts",
  "packages/testing/e2e/skill-pages.a11y.spec.ts",
  "packages/testing/e2e/context-pages.a11y.spec.ts",
] as const;

describe("WCAG 2.2 AA release matrix contract", () => {
  it("keeps every behavioral surface in the automated Axe matrix", async () => {
    const sources = await Promise.all(
      specifications.map((path) => readFile(resolve(root, path), "utf8")),
    );

    for (const source of sources) {
      expect(source).toContain("AxeBuilder");
      expect(source).toContain("390");
      expect(source).toContain("768");
      expect(source).toContain("1440");
    }
    const matrix = sources.join("\n");
    expect(matrix).toContain("colorScheme");
    expect(matrix).toContain("reducedMotion");
    expect(matrix).toContain('"dark"');
    expect(matrix).toContain('"light"');
  });

  it("retains keyboard, focus, dialog, and error-state assertions", async () => {
    const [matrix, errorPage] = await Promise.all([
      Promise.all(
        specifications.map((path) => readFile(resolve(root, path), "utf8")),
      ).then((sources) => sources.join("\n")),
      readFile(resolve(root, "app/src/routes/+error.svelte"), "utf8"),
    ]);

    for (const requiredEvidence of [
      "page.keyboard",
      "toBeFocused",
      "Escape",
      "dialog",
    ]) {
      expect(matrix.toLowerCase()).toContain(requiredEvidence.toLowerCase());
    }
    expect(errorPage).toMatch(/role=["']alert["']/u);
  });

  it("retains landmark and reduced-motion CSS contracts", async () => {
    const [workbench, application, tokens, tailwind] = await Promise.all([
      readFile(resolve(root, "packages/ui/src/workbench/Workbench.svelte"), "utf8"),
      readFile(resolve(root, "app/src/routes/+layout.svelte"), "utf8"),
      readFile(resolve(root, "packages/ui/src/styles/tokens.css"), "utf8"),
      readFile(resolve(root, "packages/ui/src/styles/tailwind.css"), "utf8"),
    ]);

    expect(`${workbench}\n${application}`).toMatch(/<(main|nav|header|aside)\b/u);
    expect(`${tokens}\n${tailwind}`).toContain(
      "@media (prefers-reduced-motion: reduce)",
    );
  });
});
