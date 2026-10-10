import { describe, expect, it } from "vitest";
import { DATAFN_RESOURCE_NAMES, DATAFN_SECRET_TABLES } from "../../src/schema.js";

describe("tenant-foundation", () => {
  it("keeps every credential, storage locator, and audit ledger out of DataFn", () => {
    expect(DATAFN_RESOURCE_NAMES).not.toContain("skillVersionFiles");
    expect(DATAFN_RESOURCE_NAMES).not.toContain("auditEvents");
    for (const table of DATAFN_SECRET_TABLES) {
      expect(DATAFN_RESOURCE_NAMES).not.toContain(table);
    }
  });
});
