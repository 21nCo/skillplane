import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertDistinctMigrationDatabases,
  assertDistinctMigrationBuckets,
  assertMigrationDatabaseRegions,
  migrationSourceRegionId,
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

  it("binds source and target databases to their requested regions", () => {
    assert.deepEqual(
      assertMigrationDatabaseRegions({
        placement: { regionId: "in-south", state: "active" },
        targetRegionId: "us-east",
        databases: {
          source: { fingerprint: "india-database" },
          target: { fingerprint: "us-database" },
        },
        regionalDatabases: {
          "in-south": { fingerprint: "india-database" },
          "us-east": { fingerprint: "us-database" },
        },
      }),
      { sourceRegionId: "in-south", targetRegionId: "us-east" },
    );
  });

  it("rejects source or target databases bound to the wrong region", () => {
    const input = {
      placement: { regionId: "in-south", state: "active" },
      targetRegionId: "us-east",
      databases: {
        source: { fingerprint: "wrong-database" },
        target: { fingerprint: "us-database" },
      },
      regionalDatabases: {
        "in-south": { fingerprint: "india-database" },
        "us-east": { fingerprint: "us-database" },
      },
    };
    assert.throws(
      () => assertMigrationDatabaseRegions(input),
      /SOURCE_DATABASE_URL must identify the in-south cell database/u,
    );
    assert.throws(
      () =>
        assertMigrationDatabaseRegions({
          ...input,
          databases: {
            source: { fingerprint: "india-database" },
            target: { fingerprint: "wrong-database" },
          },
        }),
      /TARGET_DATABASE_URL must identify the us-east cell database/u,
    );
  });

  it("uses the persisted source region while recovering a move", () => {
    assert.equal(
      migrationSourceRegionId({
        regionId: "us-east",
        previousRegionId: "in-south",
        state: "active",
        migration: {
          phase: "resume-target",
          sourceRegionId: "in-south",
        },
      }),
      "in-south",
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
