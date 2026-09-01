import {
  migrateDatafnNamespace,
  type DatafnNamespaceMigrationContext,
  type DatafnRoutingEvent,
} from "@datafn/server";
import type { WorkspacePlacement, WorkspacePlacementDirectory } from "./placement.js";
import type { PlacementSqlClient } from "./placement.js";
import { logWorkspaceRoutingEvent } from "./routing.js";

export interface MigrationCheck {
  readonly name: string;
  readonly source: string | number;
  readonly target: string | number;
  readonly matched: boolean;
}

export interface WorkspaceMigrationProof {
  readonly workspaceId: string;
  readonly sourceRegionId: string;
  readonly targetRegionId: string;
  readonly sourceEpoch: number;
  readonly finalEpoch: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly checks: readonly MigrationCheck[];
  readonly rollbackTested: boolean;
}

export interface WorkspaceMigrationOperations {
  /** Waits for asynchronous source projections while placement is still active. */
  prepareSource(workspaceId: string): Promise<void>;
  quiesceSource(context: DatafnNamespaceMigrationContext): Promise<void>;
  drainOutboxes(context: DatafnNamespaceMigrationContext): Promise<void>;
  copyDatabase(context: DatafnNamespaceMigrationContext): Promise<void>;
  copyBundles(context: DatafnNamespaceMigrationContext): Promise<void>;
  verifyDatabase(
    context: DatafnNamespaceMigrationContext,
  ): Promise<readonly MigrationCheck[]>;
  verifyBundles(
    context: DatafnNamespaceMigrationContext,
  ): Promise<readonly MigrationCheck[]>;
  rebuildGlobalResourceDirectory(
    context: DatafnNamespaceMigrationContext,
  ): Promise<void>;
  warmTarget(context: DatafnNamespaceMigrationContext): Promise<void>;
  resumeTarget(context: DatafnNamespaceMigrationContext): Promise<void>;
  rollbackSource(
    context: DatafnNamespaceMigrationContext & { readonly cause: unknown },
  ): Promise<void>;
}

export interface WorkspaceMigrationJournal {
  started(input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly sourceRegionId: string;
    readonly targetRegionId: string;
    readonly sourceEpoch: number;
  }): Promise<void>;
  completed(id: string, proof: WorkspaceMigrationProof): Promise<void>;
  failed(id: string, errorCode: string): Promise<void>;
}

export class PostgresWorkspaceMigrationJournal implements WorkspaceMigrationJournal {
  constructor(private readonly database: PlacementSqlClient) {}

  async started(input: Parameters<WorkspaceMigrationJournal["started"]>[0]) {
    await this.database.query(
      `INSERT INTO workspace_migration_runs
         (id, workspace_id, source_region_id, target_region_id, source_epoch,
          status, phase, recovery_fence, evidence)
       VALUES ($1, $2, $3, $4, $5, 'running', 'fence', $5, '{}'::jsonb)`,
      [
        input.id,
        input.workspaceId,
        input.sourceRegionId,
        input.targetRegionId,
        input.sourceEpoch,
      ],
    );
  }

  async completed(id: string, proof: WorkspaceMigrationProof) {
    await this.database.query(
      `UPDATE workspace_migration_runs
          SET status = 'completed', phase = 'complete', final_epoch = $2,
              evidence = $3::jsonb, completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [id, proof.finalEpoch, JSON.stringify(proof)],
    );
  }

  async failed(id: string, errorCode: string) {
    await this.database.query(
      `UPDATE workspace_migration_runs
          SET status = 'failed', phase = 'rollback',
              evidence = evidence || $2::jsonb,
              completed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [id, JSON.stringify({ errorCode, rollbackRequired: true })],
    );
  }
}

export function isWorkspaceMigrationRecoveryPending(
  placement: WorkspacePlacement,
): boolean {
  return (
    placement.state === "moving" ||
    (placement.state === "active" &&
      (placement.migration?.phase === "resume-source" ||
        placement.migration?.phase === "resume-target"))
  );
}

function migrationSource(placement: WorkspacePlacement): {
  readonly regionId: string;
  readonly epoch: number;
} {
  if (!isWorkspaceMigrationRecoveryPending(placement)) {
    return { regionId: placement.regionId, epoch: placement.epoch };
  }
  return {
    regionId:
      placement.migration?.sourceRegionId ??
      placement.previousRegionId ??
      placement.regionId,
    epoch: placement.migration?.sourceEpoch ?? Math.max(1, placement.epoch - 1),
  };
}

/** Composes Skillplane copy/verification hooks with DataFn's fenced move state machine. */
export async function migrateWorkspace(input: {
  readonly directory: WorkspacePlacementDirectory;
  readonly workspaceId: string;
  readonly targetRegionId: string;
  readonly targetDestinationRef?: string;
  readonly operations: WorkspaceMigrationOperations;
  readonly rollbackTested?: boolean;
  readonly now?: () => number;
  readonly onEvent?: (event: DatafnRoutingEvent) => void | Promise<void>;
}): Promise<{
  readonly placement: WorkspacePlacement;
  readonly proof: WorkspaceMigrationProof;
}> {
  const now = input.now ?? Date.now;
  const before = await input.directory.get(input.workspaceId);
  if (!before) {
    throw new Error("WORKSPACE_MIGRATION_SOURCE_NOT_ACTIVE");
  }
  const recovering = isWorkspaceMigrationRecoveryPending(before);
  if (!recovering && before.state !== "active") {
    throw new Error("WORKSPACE_MIGRATION_SOURCE_NOT_ACTIVE");
  }
  const source = migrationSource(before);
  const startedAt = new Date(now()).toISOString();
  const checks: MigrationCheck[] = [];
  // Projection consumers reject events after the placement is fenced as moving,
  // so the asynchronous backlog must converge before entering DataFn's CAS.
  if (!recovering) await input.operations.prepareSource(input.workspaceId);
  const placement = await migrateDatafnNamespace({
    directory: input.directory,
    namespace: input.workspaceId,
    targetRegionId: input.targetRegionId,
    ...(input.targetDestinationRef
      ? { targetDestinationRef: input.targetDestinationRef }
      : {}),
    hooks: {
      quiesceSource: (context) => input.operations.quiesceSource(context),
      drainPermissionDirectory: (context) => input.operations.drainOutboxes(context),
      async copyTenantData(context) {
        await input.operations.copyDatabase(context);
        await input.operations.copyBundles(context);
      },
      async validateTenantData(context) {
        checks.push(...(await input.operations.verifyDatabase(context)));
        checks.push(...(await input.operations.verifyBundles(context)));
        if (checks.length === 0 || checks.some((check) => !check.matched)) {
          throw new Error("WORKSPACE_MIGRATION_VERIFICATION_FAILED");
        }
      },
      rebuildPermissionDirectory: (context) =>
        input.operations.rebuildGlobalResourceDirectory(context),
      warmTarget: (context) => input.operations.warmTarget(context),
      resumeTarget: (context) => input.operations.resumeTarget(context),
      rollbackSource: (context) => input.operations.rollbackSource(context),
    },
    now,
    onEvent:
      input.onEvent ??
      ((event) => {
        logWorkspaceRoutingEvent("migration", event);
      }),
  });
  return {
    placement,
    proof: {
      workspaceId: input.workspaceId,
      sourceRegionId: source.regionId,
      targetRegionId: input.targetRegionId,
      sourceEpoch: source.epoch,
      finalEpoch: placement.epoch,
      startedAt,
      completedAt: new Date(now()).toISOString(),
      checks,
      rollbackTested: input.rollbackTested ?? false,
    },
  };
}

/** Exercises the real fenced rollback path before a production cutover. */
export async function runWorkspaceRollbackDrill(input: {
  readonly directory: WorkspacePlacementDirectory;
  readonly workspaceId: string;
  readonly targetRegionId: string;
  readonly targetDestinationRef?: string;
  readonly operations: WorkspaceMigrationOperations;
  readonly now?: () => number;
  readonly onEvent?: (event: DatafnRoutingEvent) => void | Promise<void>;
}): Promise<void> {
  const source = await input.directory.get(input.workspaceId);
  if (source?.state !== "active") {
    throw new Error("WORKSPACE_MIGRATION_SOURCE_NOT_ACTIVE");
  }
  const operations: WorkspaceMigrationOperations = {
    prepareSource: (workspaceId) => input.operations.prepareSource(workspaceId),
    quiesceSource: (context) => input.operations.quiesceSource(context),
    drainOutboxes: (context) => input.operations.drainOutboxes(context),
    copyDatabase: (context) => input.operations.copyDatabase(context),
    copyBundles: (context) => input.operations.copyBundles(context),
    verifyDatabase: (context) => input.operations.verifyDatabase(context),
    verifyBundles: (context) => input.operations.verifyBundles(context),
    rebuildGlobalResourceDirectory: (context) =>
      input.operations.rebuildGlobalResourceDirectory(context),
    async warmTarget(context) {
      await input.operations.warmTarget(context);
      throw new Error("WORKSPACE_MIGRATION_ROLLBACK_DRILL");
    },
    resumeTarget: (context) => input.operations.resumeTarget(context),
    rollbackSource: (context) => input.operations.rollbackSource(context),
  };
  try {
    await migrateWorkspace({ ...input, operations });
    throw new Error("WORKSPACE_MIGRATION_ROLLBACK_DRILL_DID_NOT_FAIL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "WORKSPACE_MIGRATION_ROLLBACK_DRILL"
    ) {
      throw error;
    }
  }
  const restored = await input.directory.get(input.workspaceId);
  if (
    restored?.state !== "active" ||
    restored.regionId !== source.regionId ||
    restored.epoch <= source.epoch
  ) {
    throw new Error("WORKSPACE_MIGRATION_ROLLBACK_DRILL_FAILED");
  }
}

/** Runs the fenced move while persisting operator-visible evidence. */
export async function migrateWorkspaceWithJournal(
  input: Parameters<typeof migrateWorkspace>[0] & {
    readonly journal: WorkspaceMigrationJournal;
    readonly migrationId?: string;
  },
): Promise<{
  readonly migrationId: string;
  readonly placement: WorkspacePlacement;
  readonly proof: WorkspaceMigrationProof;
}> {
  const source = await input.directory.get(input.workspaceId);
  if (
    !source ||
    (source.state !== "active" && !isWorkspaceMigrationRecoveryPending(source))
  ) {
    throw new Error("WORKSPACE_MIGRATION_SOURCE_NOT_ACTIVE");
  }
  const origin = migrationSource(source);
  const migrationId = input.migrationId ?? `workspace-migration:${crypto.randomUUID()}`;
  await input.journal.started({
    id: migrationId,
    workspaceId: input.workspaceId,
    sourceRegionId: origin.regionId,
    targetRegionId: input.targetRegionId,
    sourceEpoch: origin.epoch,
  });
  let result: Awaited<ReturnType<typeof migrateWorkspace>>;
  try {
    result = await migrateWorkspace(input);
  } catch (error) {
    const code =
      error instanceof Error && /^[A-Z0-9_:-]{1,160}$/u.test(error.message)
        ? error.message
        : "WORKSPACE_MIGRATION_FAILED";
    await input.journal.failed(migrationId, code).catch(() => undefined);
    throw error;
  }
  try {
    await input.journal.completed(migrationId, result.proof);
    return { migrationId, ...result };
  } catch (error) {
    const completion = new Error("WORKSPACE_MIGRATION_JOURNAL_COMPLETION_FAILED");
    completion.cause = error;
    throw completion;
  }
}
