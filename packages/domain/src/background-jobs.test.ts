import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backgroundJobRetryDelayMs,
  createBackgroundJobRegistry,
  enqueueJob,
  sanitizeBackgroundJobError,
  testEchoJobHandler,
  WITHHELD_BACKGROUND_JOB_ERROR,
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

// A literal backslash, so the escape vectors below reach the code as written.
const BS = "\\";

// One vector per trigger of the coarse credential rule (SKI-56 owner
// amendment): each term, each secret pattern and each escape form.
const SUSPECT_TEXT: readonly (readonly [string, string])[] = [
  ["term token", "push token abc"],
  ["term secret", "client secret"],
  ["term password", "password reset"],
  ["term passwd", "passwd file"],
  ["term apikey", "api-key"],
  ["term credential", "credential helper"],
  ["term privatekey", "private_key path"],
  ["term authorization", "authorization failed"],
  ["term cookie", "set cookie"],
  ["term bearer", "bearer scheme"],
  ["term across separators", "t.o.k.e.n"],
  ["term after NFKC", "ｔｏｋｅｎ"],
  ["term uppercase", "API_KEY"],
  ["false positive identifier", "tokenizer-v2"],
  ["URL userinfo", "https://alice:hunter2@example.com/a/b.git"],
  ["Basic scheme", "Basic dXNlcjpodW50ZXIy"],
  ["PEM private key", "-----BEGIN RSA PRIVATE KEY-----"],
  ["token prefix ghp_", `ghp_${"a".repeat(36)}`],
  ["token prefix github_pat_", `github_pat_${"A1".repeat(20)}`],
  ["token prefix glpat-", `glpat-${"a".repeat(20)}`],
  ["token prefix xoxb-", `xoxb-${"1".repeat(20)}`],
  ["token prefix sk-live_", `sk-live_${"a".repeat(20)}`],
  ["AWS access key id", "AKIAABCDEFGHIJKLMNOP"],
  ["JWT", "eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl"],
  ["backslash u escape", `to${BS}u006ben`],
  ["backslash x escape", `to${BS}x6ben`],
  ["uppercase backslash U escape", `to${BS}U0000006ben`],
  ["percent-encoded byte", "to%6Ben"],
  ["HTML character reference", "to&#107;en"],
];

describe("background job payloads", () => {
  const database = { query: vi.fn() };
  beforeEach(() => {
    database.query.mockClear();
  });
  const enqueue = (payload: Record<string, unknown>) =>
    enqueueJob(database, {
      workspaceId: "workspace:a",
      kind: "test.echo",
      idempotencyKey: "key",
      payload,
    });

  it.each(SUSPECT_TEXT)(
    "rejects a string value with %s before any query",
    async (_trigger, text) => {
      await expect(enqueue({ nested: [{ note: text }] })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      expect(database.query).not.toHaveBeenCalled();
    },
  );

  it.each(SUSPECT_TEXT)(
    "rejects a key with %s before any query",
    async (_trigger, text) => {
      await expect(enqueue({ nested: { [text]: 1 } })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      expect(database.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    // The audit metadata check still applies.
    [{ owner: "person@example.com" }],
    // A suspect value anywhere rejects the whole payload.
    [{ refs: [...Array.from({ length: 200 }, () => "main"), "Bearer abc"] }],
    [{ [`${"k".repeat(129)}`]: 1 }],
    // Text PostgreSQL jsonb cannot store.
    [{ ref: "main\u0000" }],
    [{ ref: "\ud800" }],
  ])("rejects %j before storing it", async (payload) => {
    await expect(enqueue(payload)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(database.query).not.toHaveBeenCalled();
  });

  it.each([
    ["workspace:a", "k\u0000"],
    ["workspace:a", "k\ud800"],
    ["workspace:a", "k\udfff"],
    ["workspace:\u0000", "key"],
    ["workspace:\udfff", "key"],
  ])(
    "rejects unstorable workspace %j or idempotency key %j before any query",
    async (workspaceId, idempotencyKey) => {
      await expect(
        enqueueJob(database, {
          workspaceId,
          kind: "test.echo",
          idempotencyKey,
          payload: {},
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(database.query).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Date(Date.UTC(10_000, 0, 1)),
    new Date(Date.UTC(-1, 0, 1)),
    new Date("0000-06-01T00:00:00Z"),
    new Date(Number.NaN),
  ])(
    "rejects run time %s outside the timestamptz text range before any query",
    async (runAfter) => {
      await expect(
        enqueueJob(database, {
          workspaceId: "workspace:a",
          kind: "test.echo",
          idempotencyKey: "key",
          payload: {},
          runAfter,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(database.query).not.toHaveBeenCalled();
    },
  );

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

  it("rejects exponent numbers that jsonb would expand, before any query", async () => {
    for (const payload of [
      { a: Array(200).fill(1e300), b: Array(200).fill(1e300) },
      { tiny: 1e-7 },
      { huge: 1e21 },
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

  it("accepts identifier payloads with plain numbers", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "background-job:1",
          workspace_id: "workspace:a",
          kind: "test.echo",
          idempotency_key: "key",
          payload: {},
          state: "queued",
          attempts: 0,
          run_after: new Date(),
          last_error: null,
          created_at: new Date(),
          updated_at: new Date(),
          completed_at: null,
        },
      ],
    });
    await enqueueJob(
      { query },
      {
        workspaceId: "workspace:a",
        kind: "test.echo",
        idempotencyKey: "key",
        payload: {
          sourceId: "source-1",
          attempt: 3,
          ratio: 0.25,
          status: "status=ok",
          url: "https://example.com/search?a=b&c=d",
          json: '{"note":"ready","next":"kept"}',
          command: "tool --verbose x --repo a/b",
        },
      },
    );
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("background job errors", () => {
  it.each(SUSPECT_TEXT)("withholds an error with %s whole", (_trigger, text) => {
    const message = sanitizeBackgroundJobError(
      new TypeError(`push failed: ${text} (exit 1)`),
    );
    expect(message).toBe(WITHHELD_BACKGROUND_JOB_ERROR);
    expect(message).not.toContain("TypeError");
    expect(sanitizeBackgroundJobError(text)).toBe(WITHHELD_BACKGROUND_JOB_ERROR);
  });

  it("withholds an error longer than the scan bound", () => {
    expect(sanitizeBackgroundJobError(new Error("x".repeat(16_385)))).toBe(
      WITHHELD_BACKGROUND_JOB_ERROR,
    );
  });

  it("keeps a clean error and bounds its length", () => {
    expect(
      sanitizeBackgroundJobError(
        new TypeError("push to github.com/a/b failed: 403 at 12:30:45 retry=3"),
      ),
    ).toBe("TypeError: push to github.com/a/b failed: 403 at 12:30:45 retry=3");
    expect(sanitizeBackgroundJobError(new Error("x".repeat(16_000)))).toBe(
      `Error: ${"x".repeat(1_993)}`,
    );
    expect(sanitizeBackgroundJobError({})).toBe("Unknown error");
  });

  it("replaces text PostgreSQL cannot store", () => {
    expect(
      sanitizeBackgroundJobError(new Error("bad\u0000byte \ud800 ok \u{1f600}")),
    ).toBe("Error: bad�byte � ok \u{1f600}");
    // Bounding must not leave half of a surrogate pair behind.
    const bounded = sanitizeBackgroundJobError(`${"x".repeat(1_999)}\u{1f600}`);
    expect(bounded).toBe(`${"x".repeat(1_999)}�`);
  });
});
