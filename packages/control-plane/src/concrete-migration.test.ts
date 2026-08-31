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
  it("waits for the authoritative post-fence outbox drain", async () => {
    vi.useFakeTimers();
    try {
      let projectionChecks = 0;
      const source = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("FROM regional_projection_outbox")) {
            projectionChecks += 1;
            return { rows: [{ count: projectionChecks === 1 ? "1" : "0" }] };
          }
          if (sql.includes("to_regclass")) {
            return { rows: [{ present: false }] };
          }
          return { rows: [] };
        }),
        connect: vi.fn(async () => client()),
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

      await operations.quiesceSource({
        namespace: "workspace:a",
        sourceEpoch: 1,
      } as never);
      const draining = operations.drainOutboxes({
        namespace: "workspace:a",
      } as never);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(draining).resolves.toBeUndefined();
      expect(projectionChecks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the snapshot only after the fenced outbox drain", async () => {
    const snapshot = client();
    const calls: string[] = [];
    snapshot.query.mockImplementation(async (sql) => {
      calls.push(`snapshot:${sql}`);
      return { rows: [] };
    });
    const source = {
      query: vi.fn(async (sql: string) => {
        calls.push(`pool:${sql}`);
        return { rows: [] };
      }),
      connect: vi.fn<() => Promise<MigrationSqlClient>>().mockResolvedValue(snapshot),
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
    await operations.drainOutboxes({ namespace: "workspace:a" } as never);

    expect(source.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO regional_workspace_migration_fences"),
      ["workspace:a", 1],
    );
    expect(
      calls.findIndex((call) => call.startsWith("snapshot:SELECT count(*)")),
    ).toBeGreaterThan(
      calls.findIndex((call) =>
        call.includes("INSERT INTO regional_workspace_migration_fences"),
      ),
    );
    expect(snapshot.query).toHaveBeenCalledWith(
      "SELECT count(*) FROM skills WHERE workspace_id = $1",
      ["workspace:a"],
    );
    expect(snapshot.release).not.toHaveBeenCalled();
  });

  it("keeps the source fence and clears a stale target fence before activation", async () => {
    const snapshot = client();
    const source = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn<() => Promise<MigrationSqlClient>>().mockResolvedValue(snapshot),
    } satisfies MigrationSqlPool;
    const target = {
      query: vi.fn(async () => ({ rows: [] })),
      connect: vi.fn<() => Promise<MigrationSqlClient>>().mockResolvedValue(client()),
    } satisfies MigrationSqlPool;
    const unusedObjects = {
      read: vi.fn(async () => new Uint8Array()),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const operations = new PostgresWorkspaceMigrationOperations(
      source,
      target,
      source,
      unusedObjects,
      unusedObjects,
    );

    const context = { namespace: "workspace:a", sourceEpoch: 1 } as never;
    await operations.quiesceSource(context);
    await operations.drainOutboxes(context);
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
    expect(target.query).toHaveBeenCalledWith(
      expect.stringContaining("source_epoch = 0"),
      ["workspace:a"],
    );
  });
});
