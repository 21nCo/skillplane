import { describe, expect, it, vi } from "vitest";
import {
  claimWorkspacePlacement,
  createMemoryWorkspacePlacementDirectory,
} from "./placement.js";
import {
  migrateWorkspaceWithJournal,
  runWorkspaceRollbackDrill,
  type WorkspaceMigrationOperations,
} from "./migration.js";

function operations(overrides: Partial<WorkspaceMigrationOperations> = {}) {
  const base: WorkspaceMigrationOperations = {
    prepareSource: vi.fn(async () => undefined),
    quiesceSource: vi.fn(async () => undefined),
    drainOutboxes: vi.fn(async () => undefined),
    copyDatabase: vi.fn(async () => undefined),
    copyBundles: vi.fn(async () => undefined),
    verifyDatabase: vi.fn(async () => [
      { name: "rows", source: 10, target: 10, matched: true },
    ]),
    verifyBundles: vi.fn(async () => [
      { name: "bundle-digests", source: "same", target: "same", matched: true },
    ]),
    rebuildGlobalResourceDirectory: vi.fn(async () => undefined),
    warmTarget: vi.fn(async () => undefined),
    resumeTarget: vi.fn(async () => undefined),
    rollbackSource: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides };
}

describe("fenced workspace migration", () => {
  it("moves only after database and bundle verification and journals proof", async () => {
    const directory = createMemoryWorkspacePlacementDirectory();
    await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:a",
      regionId: "in-south",
    });
    const journal = {
      started: vi.fn(async () => undefined),
      completed: vi.fn(async () => undefined),
      failed: vi.fn(async () => undefined),
    };
    const result = await migrateWorkspaceWithJournal({
      migrationId: "migration:a",
      directory,
      workspaceId: "workspace:a",
      targetRegionId: "us-east",
      operations: operations(),
      journal,
    });
    expect(result.placement).toMatchObject({
      regionId: "us-east",
      state: "active",
    });
    expect(result.proof.checks).toHaveLength(2);
    expect(result.proof.finalEpoch).toBeGreaterThan(result.proof.sourceEpoch);
    expect(journal.completed).toHaveBeenCalledWith(
      "migration:a",
      expect.objectContaining({ workspaceId: "workspace:a" }),
    );
    expect(journal.failed).not.toHaveBeenCalled();
  });

  it("rolls back and records failure when target verification differs", async () => {
    const directory = createMemoryWorkspacePlacementDirectory();
    await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:a",
      regionId: "in-south",
    });
    const rollbackSource = vi.fn(async () => undefined);
    const journal = {
      started: vi.fn(async () => undefined),
      completed: vi.fn(async () => undefined),
      failed: vi.fn(async () => undefined),
    };
    await expect(
      migrateWorkspaceWithJournal({
        migrationId: "migration:bad-copy",
        directory,
        workspaceId: "workspace:a",
        targetRegionId: "us-east",
        operations: operations({
          rollbackSource,
          verifyBundles: async () => [
            { name: "bundle-digests", source: "a", target: "b", matched: false },
          ],
        }),
        journal,
      }),
    ).rejects.toThrow("WORKSPACE_MIGRATION_VERIFICATION_FAILED");
    expect(rollbackSource).toHaveBeenCalledOnce();
    expect(journal.failed).toHaveBeenCalledWith(
      "migration:bad-copy",
      "WORKSPACE_MIGRATION_VERIFICATION_FAILED",
    );
    await expect(directory.get("workspace:a")).resolves.toMatchObject({
      regionId: "in-south",
      state: "active",
    });
  });

  it("runs the production rollback drill before a final move", async () => {
    const directory = createMemoryWorkspacePlacementDirectory();
    await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:a",
      regionId: "in-south",
    });
    const rollbackSource = vi.fn(async () => undefined);
    await runWorkspaceRollbackDrill({
      directory,
      workspaceId: "workspace:a",
      targetRegionId: "us-east",
      operations: operations({ rollbackSource }),
    });
    expect(rollbackSource).toHaveBeenCalledOnce();
    await expect(directory.get("workspace:a")).resolves.toMatchObject({
      regionId: "in-south",
      state: "active",
    });
  });

  it("finishes an expired target-resume recovery without preparing the source again", async () => {
    const directory = createMemoryWorkspacePlacementDirectory();
    const claimed = await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:resume-target",
      regionId: "legacy",
      now: () => 0,
    });
    await directory.compareAndSet({
      namespace: claimed.placement.namespace,
      expectedEpoch: claimed.placement.epoch,
      expectedState: "active",
      next: {
        namespace: claimed.placement.namespace,
        regionId: "in-south",
        epoch: 3,
        state: "active",
        previousRegionId: "legacy",
        updatedAt: new Date(1).toISOString(),
        migration: {
          phase: "resume-target",
          sourceRegionId: "legacy",
          targetRegionId: "in-south",
          sourceEpoch: 1,
          movingEpoch: 2,
          recoveryFence: 2,
          recoveryOwnerId: "interrupted-worker",
          recoveryLeaseExpiresAt: 1,
        },
      },
    });
    const migrationOperations = operations();
    const journal = {
      started: vi.fn(async () => undefined),
      completed: vi.fn(async () => undefined),
      failed: vi.fn(async () => undefined),
    };

    const result = await migrateWorkspaceWithJournal({
      directory,
      workspaceId: "workspace:resume-target",
      targetRegionId: "in-south",
      operations: migrationOperations,
      journal,
      now: () => 10,
    });

    expect(result.proof).toMatchObject({
      sourceRegionId: "legacy",
      sourceEpoch: 1,
      targetRegionId: "in-south",
    });
    expect(migrationOperations.prepareSource).not.toHaveBeenCalled();
    expect(migrationOperations.resumeTarget).toHaveBeenCalledOnce();
    const resumed = await directory.get("workspace:resume-target");
    expect(resumed).toMatchObject({ regionId: "in-south", state: "active" });
    expect(resumed?.migration).toBeUndefined();
  });

  it("finishes an expired source-resume rollback before a cutover retry", async () => {
    const directory = createMemoryWorkspacePlacementDirectory();
    const claimed = await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:resume-source",
      regionId: "legacy",
      now: () => 0,
    });
    await directory.compareAndSet({
      namespace: claimed.placement.namespace,
      expectedEpoch: claimed.placement.epoch,
      expectedState: "active",
      next: {
        namespace: claimed.placement.namespace,
        regionId: "legacy",
        epoch: 3,
        state: "active",
        updatedAt: new Date(1).toISOString(),
        migration: {
          phase: "resume-source",
          sourceRegionId: "legacy",
          targetRegionId: "in-south",
          sourceEpoch: 1,
          movingEpoch: 2,
          recoveryFence: 2,
          recoveryOwnerId: "interrupted-worker",
          recoveryLeaseExpiresAt: 1,
        },
      },
    });
    const migrationOperations = operations();
    const journal = {
      started: vi.fn(async () => undefined),
      completed: vi.fn(async () => undefined),
      failed: vi.fn(async () => undefined),
    };

    await expect(
      migrateWorkspaceWithJournal({
        directory,
        workspaceId: "workspace:resume-source",
        targetRegionId: "in-south",
        operations: migrationOperations,
        journal,
        now: () => 10,
      }),
    ).rejects.toThrow("DATAFN_MIGRATION_ROLLED_BACK");

    expect(migrationOperations.prepareSource).not.toHaveBeenCalled();
    expect(migrationOperations.rollbackSource).toHaveBeenCalledOnce();
    const rolledBack = await directory.get("workspace:resume-source");
    expect(rolledBack).toMatchObject({ regionId: "legacy", state: "active" });
    expect(rolledBack?.migration).toBeUndefined();
  });
});
