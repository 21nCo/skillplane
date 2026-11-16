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
    // Token forms under neutral keys.
    [{ ref: `ghs_${"a".repeat(36)}` }],
    [{ remote: `github_pat_${"A1".repeat(20)}` }],
    [{ url: "https://x-access-token:abc@github.com/a/b.git" }],
    [{ note: "password=hunter2" }],
    [{ note: '{"apiKey":"abc"}' }],
    // A credential past the audit redactor's 4,096 character truncation.
    [{ ref: `${"x".repeat(4_096)} Bearer abcdefghijkl` }],
    [{ refs: [...Array.from({ length: 200 }, () => "main"), "Bearer abcdefghijkl"] }],
    // Keys are checked too, including ones past the redactor's limits.
    [{ [`ghp_${"b".repeat(36)}`]: 1 }],
    [
      Object.fromEntries([
        ...Array.from({ length: 200 }, (_, i) => [`k${i}`, i]),
        ["token", "x"],
      ]),
    ],
    [{ [`${"k".repeat(129)}`]: 1 }],
    // Credential-named keys, whatever their value.
    [{ apiKey: "neutral" }],
    [{ api_key: "neutral" }],
    [{ "x-api-key": "neutral" }],
    [{ credentials: { user: "neutral" } }],
    [{ privateKey: "neutral" }],
    [{ private_key: "neutral" }],
    [{ passwd: "neutral" }],
    [{ nested: [{ githubToken: 1 }] }],
    // Text PostgreSQL jsonb cannot store.
    [{ ref: "main\u0000" }],
    [{ ref: "\ud800" }],
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
          tokenizer: undefined,
        },
      },
    );
    expect(query).toHaveBeenCalledOnce();
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
    expect(
      sanitizeBackgroundJobError(
        new Error(
          '{"token":"t1","refresh_token": "t2","client_secret":"t3",' +
            '"password":"p w","githubToken":"t4","apiKey":"t5",' +
            '"nested":"{\\"api_key\\":\\"t6\\"}"}',
        ),
      ),
    ).toBe(
      'Error: {"token":[redacted],"refresh_token": [redacted],' +
        '"client_secret":[redacted],"password":[redacted],' +
        '"githubToken":[redacted],"apiKey":[redacted],' +
        '"nested":"{\\"api_key\\":[redacted]}"}',
    );
    expect(
      sanitizeBackgroundJobError(
        `remote rejected ghs_${"a".repeat(36)}; authorization: Basic dXNlcjpwYXNz`,
      ),
    ).toBe("remote rejected [redacted]; authorization: Basic [redacted]");
    expect(sanitizeBackgroundJobError(new Error("x".repeat(5_000)))).toHaveLength(
      2_000,
    );
    expect(sanitizeBackgroundJobError({})).toBe("Unknown error");
  });

  it.each(["password", "token", "apiKey"])(
    "redacts a whole %s value containing escaped quotes, plain or nested",
    (name) => {
      const value = 'before\\"AFTER_CREDENTIAL\\\\';
      const plain = JSON.stringify({ [name]: value, next: "kept" });
      const nested = JSON.stringify({ body: plain, next: "kept" });
      const twice = JSON.stringify({ wrapper: nested });
      const quoted = JSON.stringify({
        [name]: 'before"AFTER_CREDENTIAL',
        next: "kept",
      });
      for (const text of [
        plain,
        nested,
        twice,
        quoted,
        JSON.stringify({ body: quoted, next: "kept" }),
      ]) {
        const scrubbed = sanitizeBackgroundJobError(text);
        expect(scrubbed).not.toContain("AFTER_CREDENTIAL");
        expect(scrubbed).not.toContain("before");
        expect(scrubbed).toContain("kept");
      }
      expect(sanitizeBackgroundJobError(plain)).toBe(
        `{"${name}":[redacted],"next":"kept"}`,
      );
      expect(sanitizeBackgroundJobError(nested)).toBe(
        `{"body":"{\\"${name}\\":[redacted],\\"next\\":\\"kept\\"}","next":"kept"}`,
      );
      // An unterminated value is redacted to the end.
      expect(sanitizeBackgroundJobError(`password: "open ${value}`)).toBe(
        "password: [redacted]",
      );
    },
  );

  it("replaces text PostgreSQL cannot store", () => {
    expect(
      sanitizeBackgroundJobError(new Error("bad\u0000byte \ud800 ok \u{1f600}")),
    ).toBe("Error: bad\ufffdbyte \ufffd ok \u{1f600}");
    // Bounding must not leave half of a surrogate pair behind.
    const bounded = sanitizeBackgroundJobError(`${"x".repeat(1_999)}\u{1f600}`);
    expect(bounded).toBe(`${"x".repeat(1_999)}\ufffd`);
  });
});
