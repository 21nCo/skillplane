import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertDistinctMigrationBuckets } from "./migrate-workspace.mjs";

describe("workspace migration bucket safety", () => {
  it("accepts separate source and target buckets", () => {
    assert.deepEqual(
      assertDistinctMigrationBuckets("skillplane-in-south", "skillplane-us-east"),
      {
        sourceBucket: "skillplane-in-south",
        targetBucket: "skillplane-us-east",
      },
    );
  });

  it("rejects the same bucket before migration operations start", () => {
    assert.throws(
      () =>
        assertDistinctMigrationBuckets("skillplane-in-south", "skillplane-in-south"),
      /must be distinct/u,
    );
  });
});
