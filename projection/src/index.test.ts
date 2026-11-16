import { beforeEach, expect, it, vi } from "vitest";

const steps = vi.hoisted(() => ({
  calls: [] as string[],
  outbox: vi.fn<() => Promise<{ processed: number; failed: number }>>(),
  retention: vi.fn<() => Promise<unknown>>(),
  jobs: vi.fn<() => Promise<unknown>>(),
  close: vi.fn(() => Promise.resolve()),
}));

vi.mock("@skillplane/control-plane", () => ({
  PostgresPublicProjectionDirectory: class {
    constructor(readonly pool: unknown) {}
  },
  applyPublicStatsProjectionCheckpoint: vi.fn(),
  applyRegionalPublicProjection: vi.fn(),
  createImmutableObjectPublicationStore: vi.fn(() => ({})),
  createPostgresResourceRoutingDirectory: vi.fn(() => ({})),
  createPostgresWorkspacePlacementDirectory: vi.fn(() => ({})),
  drainRegionalProjectionOutbox: () => {
    steps.calls.push("outbox");
    return steps.outbox();
  },
}));
vi.mock("@skillplane/db", () => ({
  createControlDatabaseClient: () => ({ pool: {}, close: steps.close }),
  createRegionalDatabaseClient: () => ({ pool: {}, close: steps.close }),
}));
vi.mock("@skillplane/domain", () => ({
  createBackgroundJobRegistry: () => ({ kinds: [] }),
  drainBackgroundJobs: () => {
    steps.calls.push("jobs");
    return steps.jobs();
  },
}));
vi.mock("./retention.js", () => ({
  cleanupProjectionRetention: () => {
    steps.calls.push("retention");
    return steps.retention();
  },
}));

const { drainProjectionCell } = await import("./index.js");

const bindings = {
  CONTROL_DATABASE: { connectionString: "postgres://control" },
  CELL_DATABASE: { connectionString: "postgres://cell" },
  CELL_BUNDLES: {} as R2Bucket,
  PUBLIC_BUNDLES: {} as R2Bucket,
  SKILLPLANE_REGION_ID: "in-south",
};
const drained = { succeeded: 1, failed: 0, dead: 0, lost: 0, timedOut: 0 };

beforeEach(() => {
  steps.calls.length = 0;
  steps.outbox.mockResolvedValue({ processed: 2, failed: 0 });
  steps.retention.mockResolvedValue([0, 0, 0]);
  steps.jobs.mockResolvedValue(drained);
  steps.close.mockClear();
});

it("drains background jobs after the outbox and retention work", async () => {
  await expect(drainProjectionCell(bindings)).resolves.toEqual({
    processed: 2,
    failed: 0,
    jobs: drained,
  });
  expect(steps.calls).toEqual(["outbox", "retention", "jobs"]);
  expect(steps.close).toHaveBeenCalledTimes(2);
});

it("still drains jobs when projection work fails, then rethrows that failure", async () => {
  const failure = new Error("outbox unavailable");
  steps.outbox.mockRejectedValue(failure);
  await expect(drainProjectionCell(bindings)).rejects.toBe(failure);
  expect(steps.calls).toEqual(["outbox", "jobs"]);
  expect(steps.close).toHaveBeenCalledTimes(2);
});

it("reports a background job failure after successful projection work", async () => {
  const failure = new Error("jobs unavailable");
  steps.jobs.mockRejectedValue(failure);
  await expect(drainProjectionCell(bindings)).rejects.toBe(failure);
  expect(steps.calls).toEqual(["outbox", "retention", "jobs"]);
});

it("reports both failures when projection and jobs fail in one tick", async () => {
  const projectionFailure = new Error("retention unavailable");
  const jobFailure = new Error("jobs unavailable");
  steps.retention.mockRejectedValue(projectionFailure);
  steps.jobs.mockRejectedValue(jobFailure);
  const error: unknown = await drainProjectionCell(bindings).catch(
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([projectionFailure, jobFailure]);
  expect(steps.calls).toEqual(["outbox", "retention", "jobs"]);
});
