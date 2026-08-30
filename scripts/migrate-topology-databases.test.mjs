import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  backupTopologyDatabases,
  completeTopologyCutover,
} from "./migrate-topology-databases.mjs";

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

describe("topology cutover completion", () => {
  it("locks the cutover fence while checking placements and committing completion", async () => {
    const calls = [];
    const client = {
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.includes("SELECT state")) return { rows: [{ state: "copying" }] };
        if (sql.includes("SELECT count")) return { rows: [{ count: "0" }] };
        if (sql.includes("RETURNING id"))
          return { rowCount: 1, rows: [{ id: "legacy-to-cells" }] };
        return { rows: [] };
      },
      release() {
        calls.push({ sql: "RELEASE" });
      },
    };

    await completeTopologyCutover({ connect: async () => client }, "in-south");

    assert.equal(calls[0].sql, "BEGIN");
    assert.match(calls[1].sql, /FOR UPDATE/u);
    assert.match(calls[2].sql, /LEFT JOIN workspace_placements/u);
    assert.deepEqual(calls[2].values, ["in-south"]);
    assert.match(calls[3].sql, /state = 'complete'/u);
    assert.equal(calls[4].sql, "COMMIT");
    assert.equal(calls[5].sql, "RELEASE");
  });

  it("rolls back without completing when a workspace is not placed", async () => {
    const calls = [];
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql.includes("SELECT state")) return { rows: [{ state: "copying" }] };
        if (sql.includes("SELECT count")) return { rows: [{ count: "1" }] };
        return { rows: [] };
      },
      release() {
        calls.push("RELEASE");
      },
    };

    await assert.rejects(
      completeTopologyCutover({ connect: async () => client }, "in-south"),
      /TOPOLOGY_CUTOVER_PLACEMENTS_INCOMPLETE/u,
    );
    assert.equal(calls.at(-2), "ROLLBACK");
    assert.equal(calls.at(-1), "RELEASE");
    assert.equal(
      calls.some((sql) => sql.includes?.("state = 'complete'")),
      false,
    );
  });
});
