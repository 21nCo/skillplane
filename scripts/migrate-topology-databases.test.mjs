import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backupTopologyDatabases } from "./migrate-topology-databases.mjs";

describe("topology database backups", () => {
  it("backs up and verifies the control database and every cell", async () => {
    const databases = {
      control: { fingerprint: "control" },
      cells: {
        "in-south": { fingerprint: "in-south" },
        "us-east": { fingerprint: "us-east" },
      },
    };
    const calls = [];
    const backups = await backupTopologyDatabases(databases, {
      passphrase: "test-passphrase",
      backupDatabase: async ({ database, stateDirectory }) => {
        calls.push({ fingerprint: database.fingerprint, stateDirectory });
        return {
          ok: true,
          createdAt: new Date().toISOString(),
          databaseFingerprint: database.fingerprint,
          encryptedSha256: `${database.fingerprint}-digest`,
          restoreListVerified: true,
        };
      },
    });

    assert.deepEqual(
      calls.map((call) => call.fingerprint),
      ["control", "in-south", "us-east"],
    );
    assert.equal(new Set(calls.map((call) => call.stateDirectory)).size, 3);
    assert.equal(backups.cells["us-east"].encryptedSha256, "us-east-digest");
  });
});
