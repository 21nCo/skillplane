import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubApp,
  GitHubAuthFailedError,
  INSTALLATION_TOKEN_REFRESH_MARGIN_MS,
  importGitHubAppPrivateKey,
  signGitHubAppJwt,
  type InstallationTokenRequest,
} from "./github-app.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
// GitHub issues App keys as PKCS#1.
const pkcs1 = keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8 = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
}

function verifies(jwt: string) {
  const [header = "", payload = "", signature = ""] = jwt.split(".");
  return verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    keys.publicKey,
    Buffer.from(signature, "base64url"),
  );
}

const read: InstallationTokenRequest = {
  installationId: 42,
  repositories: ["Acme/skills"],
  access: "read",
};

interface Mint {
  url: string;
  authorization: string | null;
  body: unknown;
}

// A fake token endpoint that grants what was requested unless told otherwise.
function tokenServer(
  options: {
    status?: number;
    headers?: Record<string, string>;
    message?: string;
    lifetimeMs?: number;
    token?: string;
    // Pads each granted repository object to about this many bytes.
    repositoryBytes?: number;
    grant?: (body: { repositories: string[]; permissions: { contents: string } }) => {
      contents: string;
      repositories: string[];
      // The whole permissions object to return; defaults to contents plus
      // the implicit metadata: read.
      permissions?: Record<string, string>;
    };
  } = {},
) {
  let clock = Date.parse("2026-11-18T00:00:00Z");
  let serial = 0;
  const mints: Mint[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      repositories: string[];
      permissions: { contents: string };
    };
    mints.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    if (options.status)
      return new Response(JSON.stringify({ message: options.message ?? "nope" }), {
        status: options.status,
        headers: options.headers ?? {},
      });
    const grant = options.grant?.(body) ?? {
      contents: body.permissions.contents,
      repositories: body.repositories.map((name) => `acme/${name}`),
    };
    serial += 1;
    return Response.json(
      {
        token: options.token ?? `ghs_${String(serial).padStart(36, "0")}`,
        expires_at: new Date(clock + (options.lifetimeMs ?? 3600_000)).toISOString(),
        permissions: grant.permissions ?? {
          contents: grant.contents,
          metadata: "read",
        },
        repositories: grant.repositories.map((full_name) => ({
          full_name,
          name: full_name.split("/")[1],
          description: "d".repeat(options.repositoryBytes ?? 0),
        })),
      },
      { status: 201 },
    );
  };
  const app = new GitHubApp(
    { appId: "123456", privateKeyPem: pkcs1 },
    { fetcher, now: () => clock },
  );
  return {
    app,
    mints,
    advance(ms: number) {
      clock += ms;
    },
    get now() {
      return clock;
    },
  };
}

describe("GitHub App JWT", () => {
  it("signs RS256 claims that verify against the App key, from PKCS#1 and PKCS#8", async () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    for (const pem of [pkcs1, pkcs8]) {
      const jwt = await signGitHubAppJwt(
        "123456",
        await importGitHubAppPrivateKey(pem),
        now,
      );
      const [header = "", payload = ""] = jwt.split(".");
      expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
      expect(decode(payload)).toEqual({
        iss: "123456",
        iat: now / 1000 - 60,
        exp: now / 1000 + 540,
      });
      expect(verifies(jwt)).toBe(true);
    }
  });

  it("accepts a PEM stored with escaped newlines and rejects a bad key without echoing it", async () => {
    await expect(
      importGitHubAppPrivateKey(pkcs1.replaceAll("\n", "\\n")),
    ).resolves.toBeDefined();
    const armor = (edge: "BEGIN" | "END") => `-----${edge} RSA ` + "PRIVATE KEY-----";
    const bogus = [armor("BEGIN"), "notarealkeybody", armor("END")].join("\n");
    const error = await importGitHubAppPrivateKey(bogus).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(String((error as Error).message)).not.toContain("notarealkeybody");
  });
});

describe("GitHub App installation tokens", () => {
  it("requests exactly the configured repositories and contents permission with the App JWT", async () => {
    const server = tokenServer();
    await server.app.installationToken({
      installationId: 42,
      repositories: ["acme/skills", "ACME/agents", "acme/skills"],
      access: "write",
    });
    expect(server.mints).toHaveLength(1);
    const [mint] = server.mints;
    expect(mint?.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(mint?.body).toEqual({
      repositories: ["agents", "skills"],
      permissions: { contents: "write" },
    });
    const jwt = mint?.authorization?.replace(/^Bearer /u, "") ?? "";
    expect(verifies(jwt)).toBe(true);
    expect(decode(jwt.split(".")[1] ?? "")).toMatchObject({ iss: "123456" });
  });

  it("reuses a token until five minutes before expiry and keeps scopes apart", async () => {
    const server = tokenServer();
    const first = await server.app.installationToken(read);
    server.advance(3600_000 - INSTALLATION_TOKEN_REFRESH_MARGIN_MS - 1);
    expect(await server.app.installationToken(read)).toBe(first);
    expect(server.mints).toHaveLength(1);
    // A write token for the same repository is a different scope.
    expect(await server.app.installationToken({ ...read, access: "write" })).not.toBe(
      first,
    );
    expect(server.mints).toHaveLength(2);
    server.advance(1);
    const refreshed = await server.app.installationToken(read);
    expect(refreshed).not.toBe(first);
    expect(server.mints).toHaveLength(3);
  });

  it("does not cache a token GitHub issued inside the refresh margin", async () => {
    const server = tokenServer({ lifetimeMs: INSTALLATION_TOKEN_REFRESH_MARGIN_MS });
    await server.app.installationToken(read);
    await server.app.installationToken(read);
    expect(server.mints).toHaveLength(2);
  });

  it("shares one mint between concurrent requests for the same scope", async () => {
    const server = tokenServer();
    const tokens = await Promise.all(
      Array.from({ length: 5 }, () => server.app.installationToken(read)),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(server.mints).toHaveLength(1);
  });

  it.each([
    [404, "Not Found"],
    [403, "Resource not accessible by integration"],
    [
      422,
      "There is at least one repository that does not exist or is not accessible to the parent installation.",
    ],
    [422, "The permissions requested are not granted to this installation."],
  ])(
    "maps a %s from a revoked, suspended or wrongly scoped installation to auth_failed",
    async (status, message) => {
      const server = tokenServer({ status, message });
      const error = await server.app.installationToken(read).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubAuthFailedError);
      expect(error).toMatchObject({
        code: "GIT_SOURCE_AUTH_FAILED",
        reason: "auth_failed",
        status: 409,
      });
      // A failed mint is not cached: the next request asks GitHub again.
      await server.app.installationToken(read).catch(() => undefined);
      expect(server.mints).toHaveLength(2);
    },
  );

  it("treats throttling and rejected App credentials as retryable outages, not auth_failed", async () => {
    for (const server of [
      tokenServer({ status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      // Secondary limits can arrive as a bare 403 that only says so in its body.
      tokenServer({
        status: 403,
        message: "You have exceeded a secondary rate limit. Please wait.",
      }),
      tokenServer({ status: 403, message: "API rate limit exceeded for installation" }),
      tokenServer({ status: 429 }),
      // A 422 that does not name the repository or permission is not a
      // confirmed refusal.
      tokenServer({ status: 422, message: "Spam protection triggered" }),
      tokenServer({ status: 422, message: "Validation Failed" }),
      tokenServer({ status: 401 }),
      tokenServer({ status: 502 }),
    ])
      await expect(server.app.installationToken(read)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
  });

  it("refuses a token whose permission or repositories differ from the request", async () => {
    for (const grant of [
      () => ({ contents: "read", repositories: ["acme/skills"] }),
      () => ({ contents: "write", repositories: ["acme/skills", "acme/other"] }),
      () => ({ contents: "write", repositories: ["other/skills"] }),
    ]) {
      const server = tokenServer({ grant });
      await expect(
        server.app.installationToken({ ...read, access: "write" }),
      ).rejects.toBeInstanceOf(GitHubAuthFailedError);
    }
  });

  it("refuses a token granted any permission beyond the requested contents access", async () => {
    for (const [access, permissions] of [
      ["read", { contents: "read", metadata: "read", administration: "write" }],
      ["write", { contents: "write", metadata: "read", issues: "write" }],
      ["read", { contents: "read", metadata: "write" }],
      ["read", {}],
    ] as const) {
      const server = tokenServer({
        grant: (body) => ({
          contents: body.permissions.contents,
          repositories: body.repositories.map((name) => `acme/${name}`),
          permissions,
        }),
      });
      const request = { ...read, access };
      await expect(server.app.installationToken(request)).rejects.toThrow(
        new GitHubAuthFailedError(
          "The GitHub App installation does not grant the requested repository access",
        ),
      );
      // Nothing was cached: the next call mints again.
      await expect(server.app.installationToken(request)).rejects.toBeInstanceOf(
        GitHubAuthFailedError,
      );
      expect(server.mints).toHaveLength(2);
    }
  });

  it("accepts a grant of the requested contents access with or without metadata: read", async () => {
    for (const permissions of [
      { contents: "read", metadata: "read" },
      { contents: "read" },
    ]) {
      const server = tokenServer({
        grant: (body) => ({
          contents: body.permissions.contents,
          repositories: body.repositories.map((name) => `acme/${name}`),
          permissions,
        }),
      });
      const first = await server.app.installationToken(read);
      await expect(server.app.installationToken(read)).resolves.toBe(first);
      expect(server.mints).toHaveLength(1);
    }
  });

  it("accepts legacy and stateless token formats and refuses header-unsafe ones", async () => {
    // Built at runtime: ghs_<app>_<JWT-shaped> stateless and long legacy forms.
    const stateless = ["ghs", "123456", "test-header.test-payload.test-signature"].join(
      "_",
    );
    for (const token of [stateless, `ghs_${"a".repeat(300)}`])
      expect(await tokenServer({ token }).app.installationToken(read)).toBe(token);
    for (const token of ["ghs_test token value", "ghs_test\r\nx-injected: 1", "short"])
      await expect(
        tokenServer({ token }).app.installationToken(read),
      ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("budgets the token response for full repository objects of a 500-repository scope", async () => {
    const repositories = Array.from({ length: 500 }, (_, i) => `acme/r${String(i)}`);
    const full = tokenServer({ repositoryBytes: 8 * 1024 });
    await expect(
      full.app.installationToken({ ...read, repositories }),
    ).resolves.toMatch(/^ghs_/u);
    // The budget stays finite: one repository padded far beyond it is refused.
    const oversized = tokenServer({ repositoryBytes: 512 * 1024 });
    await expect(oversized.app.installationToken(read)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "GitHub returned an oversized response",
    });
  });

  it("prunes expired tokens of every scope and bounds the cache, keeping recent ones", async () => {
    const server = tokenServer();
    const scope = (i: number) => ({ ...read, repositories: [`acme/s${String(i)}`] });
    for (let i = 0; i < 3; i += 1) await server.app.installationToken(scope(i));
    expect(server.app.cachedTokenCount).toBe(3);
    // One-off scopes past the reuse cutoff are dropped when any scope is used.
    server.advance(3600_000);
    await server.app.installationToken(read);
    expect(server.app.cachedTokenCount).toBe(1);
    const first = await server.app.installationToken(scope(0));
    for (let i = 1; i <= 256; i += 1) {
      await server.app.installationToken(scope(i));
      // scope(0) stays recently used, so it survives eviction.
      expect(await server.app.installationToken(scope(0))).toBe(first);
    }
    expect(server.app.cachedTokenCount).toBe(256);
    const mints = server.mints.length;
    // read was the least recently used and was evicted; it mints again.
    await server.app.installationToken(read);
    expect(server.mints).toHaveLength(mints + 1);
  });

  it("mints, validates and caches the scope as it was when the request was made", async () => {
    const server = tokenServer();
    const request = {
      installationId: 42,
      repositories: ["acme/skills"],
      access: "read",
    };
    const pending = server.app.installationToken(request as InstallationTokenRequest);
    Object.assign(request, { installationId: 99, access: "write" });
    request.repositories.push("acme/other");
    const token = await pending;
    expect(server.mints[0]?.url).toBe(
      "https://api.github.com/app/installations/42/access_tokens",
    );
    expect(server.mints[0]?.body).toEqual({
      repositories: ["skills"],
      permissions: { contents: "read" },
    });
    expect(await server.app.installationToken(read)).toBe(token);
    expect(server.mints).toHaveLength(1);
  });

  it("trims trailing slashes of the API base URL in linear time", () => {
    const options = { apiBaseUrl: `https://example.test${"/".repeat(200_000)}x/` };
    const started = performance.now();
    expect(
      new GitHubApp({ appId: "1", privateKeyPem: pkcs1 }, options).apiBaseUrl,
    ).toBe(`https://example.test${"/".repeat(200_000)}x`);
    const slashes = { apiBaseUrl: `https://example.test${"/".repeat(200_000)}` };
    expect(
      new GitHubApp({ appId: "1", privateKeyPem: pkcs1 }, slashes).apiBaseUrl,
    ).toBe("https://example.test");
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects malformed scopes before calling GitHub", async () => {
    const server = tokenServer();
    for (const request of [
      { ...read, installationId: 0 },
      { ...read, repositories: [] },
      { ...read, repositories: ["acme/skills", "other/skills"] },
      { ...read, repositories: ["acme/../x"] },
    ])
      await expect(server.app.installationToken(request)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    expect(server.mints).toHaveLength(0);
  });
});

describe("installation-authenticated requests", () => {
  it("replaces a rejected token once, then reports auth_failed", async () => {
    const clock = Date.parse("2026-11-18T00:00:00Z");
    let minted = 0;
    const statuses = [401, 200, 401, 401];
    const seen: (string | null)[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/access_tokens")) {
        minted += 1;
        return Response.json({
          token: `ghs_${String(minted).padStart(36, "0")}`,
          expires_at: new Date(clock + 3600_000).toISOString(),
          permissions: { contents: "read" },
          repositories: [{ full_name: "acme/skills" }],
        });
      }
      seen.push(new Headers(init?.headers).get("authorization"));
      return new Response("{}", { status: statuses.shift() ?? 200 });
    };
    const app = new GitHubApp(
      { appId: "123456", privateKeyPem: pkcs1 },
      { fetcher, now: () => clock },
    );
    const url = "https://api.github.com/repos/acme/skills";
    expect((await app.installationFetch(read, url, {})).status).toBe(200);
    expect(minted).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    await expect(app.installationFetch(read, url, {})).rejects.toBeInstanceOf(
      GitHubAuthFailedError,
    );
    expect(minted).toBe(3);
  });

  it("maps a permission refusal to auth_failed and throttling to a retryable outage", async () => {
    const clock = Date.parse("2026-11-18T00:00:00Z");
    const responses = [
      new Response(
        JSON.stringify({ message: "Resource not accessible by integration" }),
        { status: 403 },
      ),
      new Response("{}", { status: 403, headers: { "retry-after": "60" } }),
      new Response(
        JSON.stringify({ message: "You have exceeded a secondary rate limit." }),
        { status: 403 },
      ),
      new Response("{}", { status: 429 }),
      // A headerless 403 whose body breaks off before any text arrived.
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError("connection reset"));
          },
        }),
        { status: 403 },
      ),
    ];
    const fetcher: typeof fetch = async (input) =>
      String(input).endsWith("/access_tokens")
        ? Response.json({
            token: `ghs_${"1".repeat(36)}`,
            expires_at: new Date(clock + 3600_000).toISOString(),
            permissions: { contents: "read" },
            repositories: [{ full_name: "acme/skills" }],
          })
        : (responses.shift() ?? new Response("{}"));
    const app = new GitHubApp(
      { appId: "123456", privateKeyPem: pkcs1 },
      { fetcher, now: () => clock },
    );
    const url = "https://api.github.com/repos/acme/skills";
    await expect(app.installationFetch(read, url, {})).rejects.toBeInstanceOf(
      GitHubAuthFailedError,
    );
    for (let i = 0; i < 4; i += 1)
      await expect(app.installationFetch(read, url, {})).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      });
    // Installation tokens never leave api.github.com.
    await expect(
      app.installationFetch(read, "https://example.test/repos/acme/skills", {}),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
