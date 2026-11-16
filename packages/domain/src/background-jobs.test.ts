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

// esbuild cooks \u escapes even inside String.raw, so tests that need a
// literal backslash before "u" spell it with BS.
const BS = "\\";

/**
 * {"to\u006ben":"abc123","next":"kept"} wrapped `levels` times in stringified
 * JSON, with each level's escaped backslashes written as \u005c escapes.
 */
function wrapCredential(levels: number): string {
  let text = String.raw`{"to${BS}u006ben":"abc123","next":"kept"}`;
  for (let level = 0; level < levels; level += 1) {
    text = JSON.stringify({ inner: text }).replaceAll("\\\\", "\\u005c");
  }
  return text;
}

/** "token" with its "k" escaped so that decoding it takes `passes` passes. */
function chainedToken(passes: number): string {
  return `to${BS}${"u005c".repeat(passes - 1)}u006ben`;
}

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
    // Any separator between the words of a credential name.
    [{ nested: { "api.key": "neutral" } }],
    [{ nested: [{ "api key": "neutral" }] }],
    [{ nested: { "private.key": "neutral" } }],
    [{ nested: [{ "private key": "neutral" }] }],
    [{ API_KEY: "neutral" }],
    [{ list: [{ "Api-Key": "neutral" }] }],
    [{ note: "api.key=neutral" }],
    // A quoted name is classified whole by the compact key classifier.
    [{ note: '{"t.o.k.e.n":"abc123","next":"kept"}' }],
    [{ note: '{"a.p.i.key":"abc123","next":"kept"}' }],
    [{ note: '{"private.k.e.y":"abc123","next":"kept"}' }],
    // Escapes still undecoded at the decode bound fail closed.
    [{ note: wrapCredential(4) }],
    [{ note: wrapCredential(5) }],
    [{ note: `${chainedToken(4)}=abc123` }],
    [{ note: `${chainedToken(5)}=abc123` }],
    [{ nested: [{ note: `see ${chainedToken(6)}` }] }],
    // Names are classified in canonical form: JSON escapes decoded, any
    // separator run (tab, NBSP, repeated spaces) between the words.
    [{ note: String.raw`{"to${BS}u006ben":"X"}` }],
    [{ note: String.raw`{"api\tkey":"X"}` }],
    [{ note: "api  key: S1" }],
    [{ note: "api\u00a0key=S2" }],
    [{ note: JSON.stringify({ body: String.raw`{"to${BS}u006ben":"X"}` }) }],
    [{ [String.raw`to${BS}u006ben`]: 1 }],
    [{ nested: { "api\tkey": 1 } }],
    // A separator run of any length between the words, in keys and text.
    ...[16, 17, 64].flatMap((width): [Record<string, unknown>][] => {
      const gap = " ".repeat(width);
      return [
        [{ nested: { [`api${gap}key`]: "neutral" } }],
        [{ nested: [{ [`api${gap}key`]: "neutral" }] }],
        [{ nested: { [`private${"-".repeat(width)}key`]: "neutral" } }],
        [{ nested: [{ [`private${gap}key`]: "neutral" }] }],
        [{ note: `api${gap}key=x` }],
        [{ note: `private${gap}key: x` }],
      ];
    }),
    // Any non-whitespace name characters between a term and its separator.
    [{ note: "user[password]=x" }],
    [{ note: "params[token]=x" }],
    [{ note: "token[0]=x" }],
    // A name still running at the scan bound fails closed.
    [{ note: `token${"x".repeat(200)}` }],
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
        "Authorization: [redacted]",
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
    ).toBe("remote rejected [redacted]; authorization: [redacted]");
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

  it.each([
    ['{"token":["CRED1"],"next":"kept"}', '{"token":[redacted],"next":"kept"}'],
    [
      '{"credentials":{"value":"CRED2","inner":[1,"]"]},"next":"kept"}',
      '{"credentials":[redacted],"next":"kept"}',
    ],
    ['{"token":["CRED1"', '{"token":[redacted]'],
    [
      "Authorization: Token abc123SECRET\nnext: kept",
      "Authorization: [redacted]\nnext: kept",
    ],
    [
      'Authorization: Digest username="u", response="SECRET"\nkept',
      "Authorization: [redacted]\nkept",
    ],
    ["Cookie: a=b; session=SECRET", "Cookie: [redacted]"],
    ["Set-Cookie: session=SECRET; Path=/", "Set-Cookie: [redacted]"],
    ["proxy-authorization: Negotiate SECRET", "proxy-authorization: [redacted]"],
    [
      "{'password': 'pa\\'ss SECRET', 'next': 'kept'}",
      "{'password': [redacted], 'next': 'kept'}",
    ],
    ["password=hunter2 SECRET", "password=[redacted]"],
    ['{"token":12345,"next":"kept"}', '{"token":[redacted],"next":"kept"}'],
    ["api.key=SECRET", "api.key=[redacted]"],
    [
      '{"private key": "SECRET","next":"kept"}',
      '{"private key": [redacted],"next":"kept"}',
    ],
    ["the api key: SECRET", "the api key: [redacted]"],
    [`${"x".repeat(60)}_token=SECRET`, `${"x".repeat(60)}_token=[redacted]`],
    // Names are classified in canonical form, values delimited in the raw text.
    [
      String.raw`{"to${BS}u006ben":"CREDENTIAL","next":"kept"}`,
      String.raw`{"to${BS}u006ben":[redacted],"next":"kept"}`,
    ],
    [
      String.raw`{"api\tkey":"CRED2","next":"kept"}`,
      String.raw`{"api\tkey":[redacted],"next":"kept"}`,
    ],
    ["api  key: SECRET1\nnext: kept", "api  key: [redacted]\nnext: kept"],
    ["api\u00a0key=SECRET2\nnext: kept", "api\u00a0key=[redacted]\nnext: kept"],
    [
      JSON.stringify({ body: String.raw`{"to${BS}u006ben":"CRED","next":"kept"}` }),
      String.raw`{"body":"{\"to${BS}${BS}u006ben\":[redacted],\"next\":\"kept\"}"}`,
    ],
    [
      String.raw`{"to${BS}u005cu006ben":"CRED","next":"kept"}`,
      String.raw`{"to${BS}u005cu006ben":[redacted],"next":"kept"}`,
    ],
    ["gh\\u0070_" + "a".repeat(36), "[redacted]"],
  ])("redacts the whole credential value in %j", (text, expected) => {
    const scrubbed = sanitizeBackgroundJobError(text);
    expect(scrubbed).toBe(expected);
    expect(scrubbed).not.toMatch(/CRED|SECRET|hunter2|12345/u);
  });

  it.each([16, 17, 64])(
    "redacts credential names joined by %i separator characters",
    (width) => {
      const gap = " ".repeat(width);
      expect(sanitizeBackgroundJobError(`{"api${gap}key":"S1","next":"kept"}`)).toBe(
        `{"api${gap}key":[redacted],"next":"kept"}`,
      );
      expect(
        sanitizeBackgroundJobError(
          `{"private${"\t".repeat(width)}key":"S2","next":"kept"}`,
        ),
      ).toBe(`{"private${"\t".repeat(width)}key":[redacted],"next":"kept"}`);
      expect(sanitizeBackgroundJobError(`api${gap}key=S3`)).toBe(
        `api${gap}key=[redacted]`,
      );
    },
  );

  it.each([
    ["user[password]=hunter2&next=kept", "user[password]=[redacted]"],
    ["params[token]=X", "params[token]=[redacted]"],
    ["token[0]=X", "token[0]=[redacted]"],
    [
      '{"auth":{"token[0]": "X","next":"kept"}}',
      '{"auth":{"token[0]": [redacted],"next":"kept"}}',
    ],
    [`token${"x".repeat(200)}=SECRET\nnext`, "token[redacted]\nnext"],
  ])("redacts values after any credential name shape in %j", (text, expected) => {
    expect(sanitizeBackgroundJobError(text)).toBe(expected);
  });

  it("redacts nested-stringified array and object credential values", () => {
    const inner = JSON.stringify({
      token: ["CRED1", 'x"]'],
      credentials: { value: "CRED2" },
      next: "kept",
    });
    for (const text of [
      JSON.stringify({ body: inner, next: "kept" }),
      JSON.stringify({ wrapper: JSON.stringify({ body: inner }), next: "kept" }),
    ]) {
      const scrubbed = sanitizeBackgroundJobError(text);
      expect(scrubbed).not.toMatch(/CRED/u);
      expect(scrubbed).toMatch(/\\+"next\\+":\\+"kept/u);
      expect(scrubbed).toMatch(/"next":"kept"\}$/u);
    }
    expect(
      sanitizeBackgroundJobError(JSON.stringify({ body: inner, next: "kept" })),
    ).toBe(
      '{"body":"{\\"token\\":[redacted],\\"credentials\\":[redacted],' +
        '\\"next\\":\\"kept\\"}","next":"kept"}',
    );
  });

  it("bounds the scanned text without leaving part of a token", () => {
    const text = `${"x ".repeat(10_000)}ghs_${"a".repeat(36)}`;
    expect(sanitizeBackgroundJobError(text)).toHaveLength(2_000);
    // The redacted first line shrinks, so the cut token would reach the stored text.
    const line = `{"token":"${"a".repeat(16_361)}"}\n`;
    const cut = `${line}ghs_${"b".repeat(36)} tail`;
    expect(sanitizeBackgroundJobError(cut)).toBe('{"token":[redacted]} [truncated]');
  });

  it("drops a URL credential split by the scan boundary", () => {
    const url = ` https://user:SECRET_HEAD:${"b".repeat(100)}@example.com/path`;
    const withHead = (length: number) =>
      `${JSON.stringify({ token: "a".repeat(length) })}${url}`;
    // The reviewer's repro: redacting the head pulls the cut URL into the stored text.
    expect(sanitizeBackgroundJobError(withHead(16_320))).toBe(
      '{"token":[redacted]} [truncated]',
    );
    // Boundaries inside the user, inside the password and just before the "@".
    const user = url.indexOf("user") + 2;
    const password = url.indexOf("SECRET_HEAD") + 6;
    const at = url.indexOf("@");
    for (const offset of [user, user + 1, password, password + 1, at - 1, at]) {
      const text = withHead(16_384 - 12 - offset);
      expect(text[16_384]).toBe(url[offset]);
      const scrubbed = sanitizeBackgroundJobError(text);
      expect(scrubbed).toBe('{"token":[redacted]} [truncated]');
    }
    // An unterminated scheme://user:password at the end of the text.
    expect(sanitizeBackgroundJobError("clone https://user:SECRET")).toBe(
      "clone https://[redacted]",
    );
  });

  it.each(["t.o.k.e.n", "a.p.i.key", "private.k.e.y"])(
    "classifies the quoted name %s with the compact key classifier",
    (name) => {
      expect(sanitizeBackgroundJobError(`{"${name}":"abc123","next":"kept"}`)).toBe(
        `{"${name}":[redacted],"next":"kept"}`,
      );
      expect(sanitizeBackgroundJobError(`set '${name}' = 'abc123' next`)).toBe(
        `set '${name}' = [redacted] next`,
      );
    },
  );

  it("does not classify quoted free text that is not an assignment name", () => {
    expect(sanitizeBackgroundJobError('{"note":"t.o.k.e.n","next":"kept"}')).toBe(
      '{"note":"t.o.k.e.n","next":"kept"}',
    );
  });

  it.each([3, 4, 5])(
    "fails closed on escapes left at the decode bound (%i wrappers)",
    (levels) => {
      const text = wrapCredential(levels);
      const scrubbed = sanitizeBackgroundJobError(text);
      expect(scrubbed).not.toContain("abc123");
      expect(scrubbed).toMatch(/\[redacted\]$/u);
      expect(text.startsWith(scrubbed.slice(0, -"[redacted]".length))).toBe(true);
    },
  );

  it("redacts from the first escape still undecoded at the decode bound", () => {
    // Four passes decode the name and its value is redacted as usual.
    expect(sanitizeBackgroundJobError(`${chainedToken(4)}=abc123\nnext=kept`)).toBe(
      `${chainedToken(4)}=[redacted]\nnext=kept`,
    );
    // One more level leaves an escape the classifier never saw.
    expect(sanitizeBackgroundJobError(`a=b ${chainedToken(5)}=abc123\nnext=kept`)).toBe(
      "a=b to[redacted]",
    );
  });

  it("replaces text PostgreSQL cannot store", () => {
    expect(
      sanitizeBackgroundJobError(new Error("bad\u0000byte \ud800 ok \u{1f600}")),
    ).toBe("Error: bad\ufffdbyte \ufffd ok \u{1f600}");
    // Bounding must not leave half of a surrogate pair behind.
    const bounded = sanitizeBackgroundJobError(`${"x".repeat(1_999)}\u{1f600}`);
    expect(bounded).toBe(`${"x".repeat(1_999)}\ufffd`);
  });
});
