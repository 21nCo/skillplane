import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertRecentTopologyBackup,
  assertRecentTopologyMigrationState,
  createTopologyMigrationSafetyState,
} from "./lib/production-topology-safety.mjs";

const now = Date.parse("2026-08-30T12:00:00.000Z");
const manifest = {
  version: 1,
  mode: "multi-cell",
  cells: [{ regionId: "in-south" }, { regionId: "us-east" }],
};
const databases = {
  control: { fingerprint: "control" },
  cells: {
    "in-south": { fingerprint: "in-south" },
    "us-east": { fingerprint: "us-east" },
  },
};
const sourceRevision = { commit: "a".repeat(40) };
const backup = {
  ok: true,
  createdAt: "2026-08-30T11:00:00.000Z",
  databaseFingerprint: "control",
  encryptedSha256: "backup-digest",
  restoreListVerified: true,
};

function state(overrides = {}) {
  return {
    ...createTopologyMigrationSafetyState({
      createdAt: "2026-08-30T11:30:00.000Z",
      sourceRevision,
      manifest,
      databases,
      backup,
      control: { role: "control" },
      cells: {
        "in-south": { role: "regional" },
        "us-east": { role: "regional" },
      },
      cutoverComplete: true,
    }),
    ...overrides,
  };
}

describe("production topology safety evidence", () => {
  it("accepts a fresh backup and exact-commit migration record", () => {
    assert.equal(assertRecentTopologyBackup(backup, databases.control, now), backup);
    assert.equal(
      assertRecentTopologyMigrationState({
        state: state(),
        backup,
        manifest,
        databases,
        sourceRevision,
        now,
      }).applicationCommit,
      sourceRevision.commit,
    );
  });

  it("rejects a migration from another application commit", () => {
    assert.throws(
      () =>
        assertRecentTopologyMigrationState({
          state: state({ applicationCommit: "b".repeat(40) }),
          backup,
          manifest,
          databases,
          sourceRevision,
          now,
        }),
      /does not match this commit/u,
    );
  });

  it("rejects a stale migration record", () => {
    assert.throws(
      () =>
        assertRecentTopologyMigrationState({
          state: state({ createdAt: "2026-08-30T09:00:00.000Z" }),
          backup,
          manifest,
          databases,
          sourceRevision,
          now,
        }),
      /stale/u,
    );
  });
});
