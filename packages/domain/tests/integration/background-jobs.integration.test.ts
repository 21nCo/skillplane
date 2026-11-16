import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../../../db/src/migrate.js";
import { resolveTestDatabaseUrl } from "../../../db/src/database-url.js";
import {
  claimBackgroundJob,
  completeBackgroundJob,
  createBackgroundJobRegistry,
  drainBackgroundJobs,
  enqueueJob,
  listFailedBackgroundJobs,
  testEchoJobHandler,
  type BackgroundJobHandler,
} from "../../src/background-jobs.js";

// A dedicated regional cell database keeps other suites' rows out of the queue.
// This acceptance suite must fail, never skip, when no test database resolves.
const database = `skillplane_jobs_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}_test`;
let admin: Pool;
let url = "";
let pool: Pool;
const echo = createBackgroundJobRegistry([testEchoJobHandler]);

function workspace(): string {
  return `workspace:jobs-${crypto.randomUUID()}`;
}

async function enqueueEcho(workspaceId: string, key: string) {
  return (
    await enqueueJob(pool, {
      workspaceId,
      kind: "test.echo",
      idempotencyKey: key,
      payload: { key },
    })
  ).job;
}

async function row(id: string) {
  const result = await pool.query<{
    state: string;
    attempts: number;
    last_error: string | null;
    lease_owner: string | null;
    delay_seconds: number;
    completed: boolean;
  }>(
    `SELECT state, attempts, last_error, lease_owner, completed_at IS NOT NULL AS completed,
            round(EXTRACT(EPOCH FROM run_after - updated_at))::int AS delay_seconds
       FROM background_jobs WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

/** Moves a job's retry time or lease into the past, as if time had passed. */
async function makeDue(id: string) {
  await pool.query(
    `UPDATE background_jobs
        SET run_after = LEAST(run_after, now() - interval '1 second'),
            lease_expires_at = CASE WHEN state = 'running'
              THEN now() - interval '1 second' END
      WHERE id = $1`,
    [id],
  );
}

function drain(
  registry = echo,
  options: { readonly database?: Pool; readonly workerId?: string } = {},
) {
  return drainBackgroundJobs({
    database: options.database ?? pool,
    registry,
    workerId: options.workerId ?? "test-drainer",
    maxDurationMs: 30_000,
  });
}

beforeAll(async () => {
  const testUrl = new URL(await resolveTestDatabaseUrl());
  testUrl.pathname = "/postgres";
  admin = new Pool({ connectionString: testUrl.toString(), max: 1 });
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  testUrl.pathname = `/${database}`;
  url = testUrl.toString();
  await migrateDatabase(url, { role: "regional" });
  pool = new Pool({ connectionString: url, max: 4 });
}, 120_000);

beforeEach(async () => {
  await pool.query("TRUNCATE background_jobs");
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end();
});

describe("enqueueJob", () => {
  it("returns the existing job for a duplicate key, including concurrent enqueues", async () => {
    const workspaceId = workspace();
    const first = await enqueueJob(pool, {
      workspaceId,
      kind: "test.echo",
      idempotencyKey: "once",
      payload: { sourceId: "source-1" },
    });
    const second = await enqueueJob(pool, {
      workspaceId,
      kind: "test.echo",
      idempotencyKey: "once",
      payload: { sourceId: "source-2" },
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ job: first.job, created: false });
    expect(second.job.payload).toEqual({ sourceId: "source-1" });

    const racing = await Promise.all(
      Array.from({ length: 6 }, () =>
        enqueueJob(pool, {
          workspaceId,
          kind: "test.echo",
          idempotencyKey: "race",
          payload: {},
        }),
      ),
    );
    expect(racing.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(racing.map((result) => result.job.id)).size).toBe(1);

    // The key is scoped to the workspace and kind.
    const elsewhere = await enqueueJob(pool, {
      workspaceId: workspace(),
      kind: "test.echo",
      idempotencyKey: "once",
      payload: {},
    });
    expect(elsewhere.created).toBe(true);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*) FROM background_jobs",
    );
    expect(count.rows[0]?.count).toBe("3");
  });

  it("delays a job until runAfter", async () => {
    const workspaceId = workspace();
    await enqueueJob(pool, {
      workspaceId,
      kind: "test.echo",
      idempotencyKey: "later",
      payload: {},
      runAfter: new Date(Date.now() + 60_000),
    });
    expect(await drain()).toEqual({ succeeded: 0, failed: 0, dead: 0, lost: 0 });
  });
});

describe("drainBackgroundJobs", () => {
  it("runs each job exactly once per attempt across two concurrent drainers", async () => {
    const workspaceId = workspace();
    const jobs = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        enqueueEcho(workspaceId, `job-${index}`),
      ),
    );
    const runs: string[] = [];
    const registry = createBackgroundJobRegistry([
      {
        kind: "test.echo",
        async run(job) {
          runs.push(`${job.id}#${job.attempt}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
      },
    ]);
    const second = new Pool({ connectionString: url, max: 4 });
    try {
      const results = await Promise.all([
        drain(registry, { workerId: "drainer-a" }),
        drain(registry, { database: second, workerId: "drainer-b" }),
      ]);
      expect(results.reduce((sum, result) => sum + result.succeeded, 0)).toBe(30);
      expect(results.every((result) => result.succeeded > 0)).toBe(true);
    } finally {
      await second.end();
    }
    expect(runs).toHaveLength(30);
    expect(new Set(runs)).toEqual(new Set(jobs.map((job) => `${job.id}#1`)));
    const states = await pool.query<{ state: string; attempts: number; count: string }>(
      "SELECT state, attempts, count(*) FROM background_jobs GROUP BY state, attempts",
    );
    expect(states.rows).toEqual([{ state: "succeeded", attempts: 1, count: "30" }]);
  });

  it("retries a throwing handler with backoff and marks it dead after max attempts", async () => {
    const workspaceId = workspace();
    const attempts: number[] = [];
    const registry = createBackgroundJobRegistry([
      {
        kind: "test.fail",
        maxAttempts: 3,
        async run(job) {
          attempts.push(job.attempt);
          throw new Error("remote rejected push token=abc123");
        },
      },
    ]);
    const { job } = await enqueueJob(pool, {
      workspaceId,
      kind: "test.fail",
      idempotencyKey: "fail",
      payload: { sourceId: "source-1" },
    });

    expect(await drain(registry)).toMatchObject({ failed: 1 });
    expect(await row(job.id)).toMatchObject({
      state: "failed",
      attempts: 1,
      lease_owner: null,
      delay_seconds: 30,
      completed: false,
      last_error: "Error: remote rejected push token=[redacted]",
    });
    // Not due yet: a second tick leaves it alone.
    expect(await drain(registry)).toMatchObject({ failed: 0 });

    await makeDue(job.id);
    expect(await drain(registry)).toMatchObject({ failed: 1 });
    expect(await row(job.id)).toMatchObject({
      state: "failed",
      attempts: 2,
      delay_seconds: 60,
    });

    await makeDue(job.id);
    expect(await drain(registry)).toMatchObject({ dead: 1 });
    expect(await row(job.id)).toMatchObject({
      state: "dead",
      attempts: 3,
      completed: true,
      last_error: "Error: remote rejected push token=[redacted]",
    });
    await makeDue(job.id);
    expect(await drain(registry)).toMatchObject({ dead: 0, failed: 0 });
    expect(attempts).toEqual([1, 2, 3]);

    const listed = await listFailedBackgroundJobs(pool, { workspaceId });
    expect(listed).toEqual([
      expect.objectContaining({
        id: job.id,
        kind: "test.fail",
        state: "dead",
        attempts: 3,
      }),
    ]);
    expect(Object.keys(listed[0] ?? {})).not.toContain("payload");
    expect(await listFailedBackgroundJobs(pool, { workspaceId: workspace() })).toEqual(
      [],
    );
  });

  it("reclaims a job whose drainer died mid-run and completes it", async () => {
    const workspaceId = workspace();
    const job = await enqueueEcho(workspaceId, "crash");
    // The first drainer claims the job and then dies before finishing it.
    const crashed = await claimBackgroundJob({
      database: pool,
      registry: echo,
      workerId: "crashed-drainer",
    });
    expect(crashed.type).toBe("claimed");
    if (crashed.type !== "claimed") return;

    // While the lease is live, no other drainer can take the job.
    expect(await drain()).toEqual({ succeeded: 0, failed: 0, dead: 0, lost: 0 });
    expect(await row(job.id)).toMatchObject({ state: "running", attempts: 1 });

    await makeDue(job.id);
    expect(await drain()).toMatchObject({ succeeded: 1 });
    expect(await row(job.id)).toMatchObject({
      state: "succeeded",
      attempts: 2,
      lease_owner: null,
      last_error: null,
      completed: true,
    });

    // The stale drainer cannot overwrite the reclaimed job's outcome.
    expect(
      await completeBackgroundJob({
        database: pool,
        job: crashed.job,
        maxAttempts: 8,
        error: new Error("late failure"),
      }),
    ).toBe("lost");
    expect(await row(job.id)).toMatchObject({ state: "succeeded", attempts: 2 });
  });

  it("marks a job dead when its last allowed attempt loses its lease", async () => {
    const registry = createBackgroundJobRegistry([
      { ...testEchoJobHandler, maxAttempts: 1 },
    ]);
    const job = await enqueueEcho(workspace(), "last-crash");
    expect(
      (await claimBackgroundJob({ database: pool, registry, workerId: "w" })).type,
    ).toBe("claimed");
    await makeDue(job.id);
    expect(await drain(registry)).toMatchObject({ dead: 1, succeeded: 0 });
    expect(await row(job.id)).toMatchObject({
      state: "dead",
      attempts: 1,
      last_error: "Lease expired before the job finished",
    });
  });

  it("fails a run that outlives its lease and aborts the handler", async () => {
    let aborted = false;
    const registry = createBackgroundJobRegistry([
      {
        kind: "test.hang",
        leaseMs: 50,
        run: (job) =>
          new Promise<void>((resolve) => {
            job.signal.addEventListener("abort", () => {
              aborted = true;
              resolve();
            });
          }),
      },
    ]);
    const { job } = await enqueueJob(pool, {
      workspaceId: workspace(),
      kind: "test.hang",
      idempotencyKey: "hang",
      payload: {},
    });
    expect(await drain(registry)).toMatchObject({ failed: 1 });
    expect(aborted).toBe(true);
    expect(await row(job.id)).toMatchObject({
      state: "failed",
      last_error: "BackgroundJobTimeoutError: Job exceeded its lease",
    });
  });

  it("stops starting jobs when the tick budget is spent", async () => {
    const workspaceId = workspace();
    for (let index = 0; index < 6; index += 1)
      await enqueueEcho(workspaceId, `b-${index}`);
    let now = 0;
    const registry = createBackgroundJobRegistry([
      {
        kind: "test.echo",
        async run() {
          now += 10;
        },
      },
    ]);
    const result = await drainBackgroundJobs({
      database: pool,
      registry,
      workerId: "budget",
      maxDurationMs: 25,
      clock: () => now,
    });
    // Runs start at 0, 10 and 20; at 30 the budget is spent.
    expect(result.succeeded).toBe(3);
    const queued = await pool.query<{ count: string }>(
      "SELECT count(*) FROM background_jobs WHERE state = 'queued'",
    );
    expect(queued.rows[0]?.count).toBe("3");
  });

  it("skips unregistered kinds and workspaces fenced for migration", async () => {
    const fenced = workspace();
    const open = workspace();
    const fencedJob = await enqueueEcho(fenced, "fenced");
    const openJob = await enqueueEcho(open, "open");
    const { job: unknownJob } = await enqueueJob(pool, {
      workspaceId: open,
      kind: "test.unknown",
      idempotencyKey: "unknown",
      payload: {},
    });
    await pool.query(
      `UPDATE regional_workspace_migration_fences SET source_epoch = 2
        WHERE workspace_id = $1`,
      [fenced],
    );
    try {
      expect(await drain()).toMatchObject({ succeeded: 1 });
      expect(await row(openJob.id)).toMatchObject({ state: "succeeded" });
      expect(await row(fencedJob.id)).toMatchObject({ state: "queued", attempts: 0 });
      expect(await row(unknownJob.id)).toMatchObject({ state: "queued", attempts: 0 });
    } finally {
      await pool.query(
        "UPDATE regional_workspace_migration_fences SET source_epoch = 0 WHERE workspace_id = $1",
        [fenced],
      );
    }
    expect(await drain()).toMatchObject({ succeeded: 1 });
    expect(await row(fencedJob.id)).toMatchObject({ state: "succeeded" });
  });
});

describe("test handlers", () => {
  it("keeps the echo handler a no-op", async () => {
    const handler: BackgroundJobHandler = testEchoJobHandler;
    await expect(
      handler.run({
        id: "job",
        workspaceId: "workspace",
        kind: "test.echo",
        payload: {},
        attempt: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });
});
