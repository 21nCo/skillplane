import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SKILLPLANE_POSTGRES_PORT,
  rebindLocalRuntimePort,
  selectLocalPostgresPort,
} from "./local-postgres-port.mjs";

describe("local Postgres port selection", () => {
  it("uses the dedicated Skillplane port for a new runtime", () => {
    assert.equal(
      selectLocalPostgresPort(undefined, undefined),
      DEFAULT_SKILLPLANE_POSTGRES_PORT,
    );
  });

  it("migrates persisted runtimes from former defaults", () => {
    assert.equal(
      selectLocalPostgresPort(undefined, 5_432),
      DEFAULT_SKILLPLANE_POSTGRES_PORT,
    );
    assert.equal(
      selectLocalPostgresPort(undefined, 55_432),
      DEFAULT_SKILLPLANE_POSTGRES_PORT,
    );
  });

  it("preserves a persisted custom port", () => {
    assert.equal(selectLocalPostgresPort(undefined, 64_321), 64_321);
  });

  it("honors an explicit override", () => {
    assert.equal(selectLocalPostgresPort("6432", 5_432), "6432");
  });

  it("updates all persisted database URLs without changing credentials", () => {
    const runtime = rebindLocalRuntimePort(
      {
        port: 5_432,
        database: "skillplane",
        testDatabase: "skillplane_test",
        user: "skillplane_app",
        password: "secret",
        databaseUrl: "postgresql://skillplane_app:secret@127.0.0.1:5432/skillplane",
        testDatabaseUrl:
          "postgresql://skillplane_app:secret@127.0.0.1:5432/skillplane_test",
      },
      DEFAULT_SKILLPLANE_POSTGRES_PORT,
    );

    assert.equal(runtime.port, DEFAULT_SKILLPLANE_POSTGRES_PORT);
    assert.equal(new URL(runtime.databaseUrl).port, "5703");
    assert.equal(new URL(runtime.testDatabaseUrl).port, "5703");
    assert.equal(runtime.password, "secret");
  });
});
