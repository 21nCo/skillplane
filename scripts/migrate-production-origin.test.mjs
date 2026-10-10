import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateProductionOrigin } from "./migrate-production-origin.mjs";

function database(name, fingerprint) {
  return {
    identity: { database: name },
    fingerprint,
  };
}

describe("production origin migration orchestration", () => {
  it("backs up the frozen source, restores the target, then verifies target safety", async () => {
    const calls = [];
    const source = database("old_skillplane", "source");
    const target = database("live_skillplane", "target");
    let backupCount = 0;
    const result = await migrateProductionOrigin(
      [
        "--confirm-source-write-frozen",
        source.identity.database,
        "--confirm-empty-database",
        target.identity.database,
      ],
      {
        source,
        target,
        backup: async ({ database: selected }) => {
          calls.push(["backup", selected.fingerprint]);
          backupCount += 1;
          return { manifest: `backup-${backupCount}.manifest.json` };
        },
        restore: async (arguments_, { database: selected }) => {
          calls.push(["restore", selected.fingerprint, arguments_[1]]);
          return { ok: true, evidence: "restore.json" };
        },
        migrate: async ({ database: selected }) => {
          calls.push(["migrate", selected.fingerprint]);
          return { ok: true, createdAt: "2026-08-23T00:00:00.000Z" };
        },
      },
    );

    assert.deepEqual(calls, [
      ["backup", "source"],
      ["restore", "target", "backup-1.manifest.json"],
      ["backup", "target"],
      ["migrate", "target"],
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.targetBackup, "backup-2.manifest.json");
  });

  it("requires explicit source-freeze confirmation", async () => {
    await assert.rejects(
      () =>
        migrateProductionOrigin(["--confirm-empty-database", "live_skillplane"], {
          source: database("old_skillplane", "source"),
          target: database("live_skillplane", "target"),
        }),
      /confirm-source-write-frozen.*required/u,
    );
  });

  it("requires distinct source and target databases", async () => {
    const source = database("skillplane", "same");
    await assert.rejects(
      () =>
        migrateProductionOrigin(
          [
            "--confirm-source-write-frozen",
            "skillplane",
            "--confirm-empty-database",
            "skillplane",
          ],
          { source, target: source },
        ),
      /must be different databases/u,
    );
  });
});
