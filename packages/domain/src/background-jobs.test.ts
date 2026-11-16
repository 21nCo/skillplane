import { describe, expect, it, vi } from "vitest";
import {
  backgroundJobRetryDelayMs,
  createBackgroundJobRegistry,
  enqueueJob,
  sanitizeBackgroundJobError,
  testEchoJobHandler,
} from "./background-jobs.js";

describe("background job retry backoff", () => {
  it("doubles from 30 seconds and caps at one hour", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 40].map(backgroundJobRetryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000,
      3_600_000, 3_600_000,
    ]);
  });
});

describe("background job registry", () => {
  it("defaults to 8 attempts and honors a per-kind override", () => {
    const registry = createBackgroundJobRegistry([
      testEchoJobHandler,
      {
        kind: "git.push",
        maxAttempts: 3,
        leaseMs: 1_000,
        run: () => Promise.resolve(),
      },
    ]);
    expect(registry.kinds).toEqual(["git.push", "test.echo"]);
    expect(registry.get("test.echo")).toMatchObject({
      maxAttempts: 8,
      leaseMs: 300_000,
    });
    expect(registry.get("git.push")).toMatchObject({ maxAttempts: 3, leaseMs: 1_000 });
    expect(() => registry.get("git.pull")).toThrow("BACKGROUND_JOB_HANDLER_MISSING");
  });

  it("rejects duplicate kinds, malformed kinds and invalid limits", () => {
    expect(() =>
      createBackgroundJobRegistry([testEchoJobHandler, testEchoJobHandler]),
    ).toThrow("BACKGROUND_JOB_HANDLER_DUPLICATE:test.echo");
    expect(() =>
      createBackgroundJobRegistry([{ kind: "echo", run: () => Promise.resolve() }]),
    ).toThrow("Background job kind is invalid");
    expect(() =>
      createBackgroundJobRegistry([
        { kind: "test.zero", maxAttempts: 0, run: () => Promise.resolve() },
      ]),
    ).toThrow("BACKGROUND_JOB_MAX_ATTEMPTS_INVALID");
  });
});

describe("background job payloads", () => {
  const database = { query: vi.fn() };

  it.each([
    [{ token: "abc" }],
    [{ nested: { apiSecret: "abc" } }],
    [{ header: "Bearer abcdefghijkl" }],
    [{ owner: "person@example.com" }],
  ])("rejects secrets and personal data before storing %j", async (payload) => {
    await expect(
      enqueueJob(database, {
        workspaceId: "workspace:a",
        kind: "test.echo",
        idempotencyKey: "key",
        payload,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(database.query).not.toHaveBeenCalled();
  });

  it("rejects oversized and non-object payloads", async () => {
    for (const payload of [
      { blob: "x".repeat(17_000) },
      [] as unknown as Record<string, unknown>,
    ]) {
      await expect(
        enqueueJob(database, {
          workspaceId: "workspace:a",
          kind: "test.echo",
          idempotencyKey: "key",
          payload,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(database.query).not.toHaveBeenCalled();
  });
});

describe("background job errors", () => {
  it("scrubs credentials and bounds the stored message", () => {
    const message = sanitizeBackgroundJobError(
      new Error(
        "push to https://x-access-token:ghs_abcdefghijklmnop@github.com/a/b failed; " +
          "Authorization: Bearer abc.def token=xyz",
      ),
    );
    expect(message).toBe(
      "Error: push to https://[redacted]@github.com/a/b failed; " +
        "Authorization: Bearer [redacted] token=[redacted]",
    );
    expect(sanitizeBackgroundJobError(new Error("x".repeat(5_000)))).toHaveLength(
      2_000,
    );
    expect(sanitizeBackgroundJobError({})).toBe("Unknown error");
  });
});
