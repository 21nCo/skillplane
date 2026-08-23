import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateDevelopment } from "./migrate-development.mjs";

describe("development database migration", () => {
  it("migrates and verifies the same explicit development database", () => {
    const database = {
      url: "postgresql://dev:secret@database.example.test:5432/skillplane_dev",
      fingerprint: "development-database-fingerprint",
    };
    const calls = [];

    const result = migrateDevelopment({
      database,
      run(command, arguments_, options) {
        calls.push({ command, arguments_, options });
      },
    });

    assert.equal(result.databaseFingerprint, database.fingerprint);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.command, "pnpm");
      assert.equal(call.options.env.MIGRATION_DATABASE_URL, database.url);
      assert.equal(call.options.env.DATABASE_URL, "");
    }
    assert.deepEqual(
      calls.map((call) => call.arguments_.at(-1)),
      ["migrate", "verify"],
    );
  });
});
