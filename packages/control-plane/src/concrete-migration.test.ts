import { describe, expect, it, vi } from "vitest";
import {
  PostgresWorkspaceMigrationOperations,
  type MigrationSqlClient,
  type MigrationSqlPool,
} from "./concrete-migration.js";

function client() {
  return {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  } satisfies MigrationSqlClient;
}

describe("concrete workspace migration", () => {
  it("releases the write-drain barrier before retaining the source snapshot", async () => {
    const barrier = client();
    const snapshot = client();
    const source = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi
        .fn<() => Promise<MigrationSqlClient>>()
        .mockResolvedValueOnce(barrier)
        .mockResolvedValueOnce(snapshot),
    } satisfies MigrationSqlPool;
    const unusedPool = source;
    const unusedObjects = {
      read: vi.fn(async () => new Uint8Array()),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const operations = new PostgresWorkspaceMigrationOperations(
      source,
      unusedPool,
      unusedPool,
      unusedObjects,
      unusedObjects,
    );

    await operations.quiesceSource({ namespace: "workspace:a" } as never);

    expect(barrier.query).toHaveBeenCalledWith("COMMIT");
    expect(barrier.release).toHaveBeenCalledOnce();
    expect(snapshot.query).toHaveBeenCalledWith(
      "SELECT count(*) FROM skills WHERE workspace_id = $1",
      ["workspace:a"],
    );
    expect(snapshot.release).not.toHaveBeenCalled();
  });
});
