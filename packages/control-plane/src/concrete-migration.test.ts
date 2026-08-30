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
  it("retains the snapshot before releasing the write-drain barrier", async () => {
    const barrier = client();
    const snapshot = client();
    const calls: string[] = [];
    barrier.query.mockImplementation(async (sql) => {
      calls.push(`barrier:${sql}`);
      return { rows: [] };
    });
    snapshot.query.mockImplementation(async (sql) => {
      calls.push(`snapshot:${sql}`);
      return { rows: [] };
    });
    const source = {
      query: vi.fn(async (sql: string) => {
        calls.push(`pool:${sql}`);
        return { rows: [] };
      }),
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

    await operations.quiesceSource({
      namespace: "workspace:a",
      sourceEpoch: 1,
    } as never);

    expect(source.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO regional_workspace_migration_fences"),
      ["workspace:a", 1],
    );
    expect(
      calls.findIndex((call) => call.startsWith("snapshot:SELECT count(*)")),
    ).toBeLessThan(calls.indexOf("barrier:COMMIT"));
    expect(barrier.release).toHaveBeenCalledOnce();
    expect(snapshot.query).toHaveBeenCalledWith(
      "SELECT count(*) FROM skills WHERE workspace_id = $1",
      ["workspace:a"],
    );
    expect(snapshot.release).not.toHaveBeenCalled();
  });

  it("keeps the source-cell fence after the retained snapshot is released", async () => {
    const barrier = client();
    const snapshot = client();
    const source = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi
        .fn<() => Promise<MigrationSqlClient>>()
        .mockResolvedValueOnce(barrier)
        .mockResolvedValueOnce(snapshot),
    } satisfies MigrationSqlPool;
    const unusedObjects = {
      read: vi.fn(async () => new Uint8Array()),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const operations = new PostgresWorkspaceMigrationOperations(
      source,
      source,
      source,
      unusedObjects,
      unusedObjects,
    );

    const context = { namespace: "workspace:a", sourceEpoch: 1 } as never;
    await operations.quiesceSource(context);
    expect(source.query).not.toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM regional_workspace_migration_fences"),
      expect.anything(),
    );

    await operations.resumeTarget(context);
    expect(snapshot.query).toHaveBeenCalledWith("COMMIT");
    expect(source.query).not.toHaveBeenCalledWith(
      expect.stringContaining("regional_workspace_migration_fences"),
      ["workspace:a"],
    );
  });
});
