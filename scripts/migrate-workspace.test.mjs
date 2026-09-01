import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertDistinctMigrationDatabases,
  assertDistinctMigrationBuckets,
  requiresWorkspaceRollbackDrill,
} from "./migrate-workspace.mjs";

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

describe("workspace migration database safety", () => {
  it("rejects a control database aliased to either regional database", () => {
    assert.throws(
      () =>
        assertDistinctMigrationDatabases({
          control: { fingerprint: "same" },
          source: { fingerprint: "same" },
          target: { fingerprint: "target" },
        }),
      /control, source, and target databases must be distinct/u,
    );
  });
});

describe("workspace migration recovery", () => {
  it("runs the rollback drill only for a fresh active placement", () => {
    assert.equal(
      requiresWorkspaceRollbackDrill({ state: "active", migration: null }),
      true,
    );
    assert.equal(
      requiresWorkspaceRollbackDrill({ state: "moving", migration: null }),
      false,
    );
    assert.equal(
      requiresWorkspaceRollbackDrill({
        state: "active",
        migration: { phase: "resume-target" },
      }),
      false,
    );
  });
});
