import {
  cleanupProcessedRegionalProjectionOutbox,
  cleanupPublicStatsProjectionEvents,
  cleanupControlPlaneAuditReads,
} from "@skillplane/control-plane";

type Database = Parameters<
  typeof cleanupProcessedRegionalProjectionOutbox
>[0]["database"];
const batchSize = 5_000;

/** Give each retention stream repeated batches within one shared soft deadline. */
export async function cleanupProjectionRetention(input: {
  readonly regionalDatabase: Database;
  readonly controlDatabase: Database;
  readonly maxDurationMs?: number;
}): Promise<readonly number[]> {
  const maxDurationMs = input.maxDurationMs ?? 10_000;
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
    throw new Error("PROJECTION_RETENTION_BUDGET_INVALID");
  }
  const deadline = performance.now() + maxDurationMs;
  async function drain(cleanup: () => Promise<number>): Promise<number> {
    let retired = 0;
    while (performance.now() < deadline) {
      const count = await cleanup();
      retired += count;
      if (count < batchSize) break;
    }
    return retired;
  }
  return Promise.all([
    drain(() =>
      cleanupProcessedRegionalProjectionOutbox({
        database: input.regionalDatabase,
        limit: batchSize,
      }),
    ),
    drain(() =>
      cleanupPublicStatsProjectionEvents({
        database: input.controlDatabase,
        limit: batchSize,
      }),
    ),
    drain(() => cleanupControlPlaneAuditReads({ database: input.controlDatabase })),
  ]);
}
