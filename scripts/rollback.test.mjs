import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertDatabaseRollbackSafe } from "./rollback.mjs";

function snapshot(overrides = {}) {
  return {
    databaseFingerprint: "database-fingerprint",
    migrationLedgerDigest: "migration-digest",
    schemaDigest: "schema-digest",
    immutableTableStateDigest: "immutable-data-digest",
    tableState: {
      api_rate_limits: { count: "1", digest: "rate-limit-before" },
      skills: { count: "2", digest: "skills-digest" },
    },
    ...overrides,
  };
}

describe("production rollback database safety", () => {
  it("allows only operational rate-limit counters to change", () => {
    const result = assertDatabaseRollbackSafe(
      snapshot(),
      snapshot({
        tableState: {
          api_rate_limits: { count: "1", digest: "rate-limit-after" },
          skills: { count: "2", digest: "skills-digest" },
        },
      }),
    );

    assert.deepEqual(result, {
      immutableTableStateUnchanged: true,
      operationalTablesAllowedToChange: ["api_rate_limits"],
      operationalTableStateChanged: true,
    });
  });

  it("rejects durable row changes", () => {
    assert.throws(
      () =>
        assertDatabaseRollbackSafe(
          snapshot(),
          snapshot({ immutableTableStateDigest: "changed" }),
        ),
      /Durable database row state changed/u,
    );
  });

  it("rejects migration and schema changes", () => {
    assert.throws(
      () =>
        assertDatabaseRollbackSafe(
          snapshot(),
          snapshot({ migrationLedgerDigest: "changed" }),
        ),
      /migration ledger changed/u,
    );
    assert.throws(
      () =>
        assertDatabaseRollbackSafe(snapshot(), snapshot({ schemaDigest: "changed" })),
      /schema changed/u,
    );
  });
});
