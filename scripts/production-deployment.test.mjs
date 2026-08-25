import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertMigrationApplicationCompatibility } from "./lib/production-deployment.mjs";

describe("production migration and application compatibility", () => {
  it("accepts deployment from the exact commit that produced the migration record", () => {
    assert.deepEqual(
      assertMigrationApplicationCompatibility(
        { applicationCommit: "a".repeat(40) },
        "a".repeat(40),
      ),
      { applicationCommit: "a".repeat(40) },
    );
  });

  it("rejects an older, newer, or unversioned application binary", () => {
    assert.throws(
      () =>
        assertMigrationApplicationCompatibility(
          { applicationCommit: "a".repeat(40) },
          "b".repeat(40),
        ),
      /same Git commit/u,
    );
    assert.throws(
      () => assertMigrationApplicationCompatibility({}, "a".repeat(40)),
      /same Git commit/u,
    );
    assert.throws(
      () =>
        assertMigrationApplicationCompatibility({
          applicationCommit: "a".repeat(40),
        }),
      /same Git commit/u,
    );
  });
});
