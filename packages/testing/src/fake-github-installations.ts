import { generateKeyPairSync, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// A fake of the GitHub pieces the App install flow uses: the install page
// (which redirects back to the App's callback URL), the OAuth code exchange,
// `GET /user`, `GET /user/memberships/orgs/:org`, App-JWT
// `GET /app/installations/:id`, a metadata-only installation token and
// `GET /installation/repositories`.
// The App key pair is generated per run; no credential is committed.

export interface FakeGitHubInstallation {
  readonly id: number;
  readonly account: { readonly login: string; readonly type: "User" | "Organization" };
  repositorySelection: "all" | "selected";
  repositories: { fullName: string; private: boolean; defaultBranch: string }[];
  suspendedAt: string | null;
  removed: boolean;
  /** Organization memberships by GitHub user; unused for a User account. */
  readonly memberships: Map<string, FakeGitHubMembership>;
}

export interface FakeGitHubMembership {
  state: "active" | "pending";
  role: "admin" | "member";
}

export interface FakeGitHubFailure {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}

export interface FakeGitHubInstallations {
  /** Web base (install and OAuth pages). */
  readonly webBaseUrl: string;
  /** REST API base. */
  readonly apiBaseUrl: string;
  readonly appId: string;
  readonly appPrivateKeyPem: string;
  readonly installations: Map<number, FakeGitHubInstallation>;
  /** The App's callback URL the install page returns to. */
  callbackUrl: string;
  /** What the next install page visit installs, and as which GitHub user. */
  nextInstall: { installationId: number; user: string } | null;
  /** `users` become the organization's active admins. */
  addInstallation(
    installation: Omit<
      FakeGitHubInstallation,
      "memberships" | "suspendedAt" | "removed"
    > & {
      users: string[];
    },
  ): FakeGitHubInstallation;
  /** Answers to give instead, keyed by `METHOD path` (API path, no prefix). */
  readonly failures: Map<string, FakeGitHubFailure>;
  /** An authorization code for a GitHub user, as GitHub's redirect carries. */
  issueCode(user: string): string;
  /** Every request as `METHOD path`. */
  readonly requests: string[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

export async function startFakeGitHubInstallations(
  options: { appId?: string } = {},
): Promise<FakeGitHubInstallations> {
  const appId = options.appId ?? "424242";
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const appPrivateKeyPem = keys.privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  const installations = new Map<number, FakeGitHubInstallation>();
  const codes = new Map<string, string>();
  const userTokens = new Map<string, string>();
  const installationTokens = new Map<string, number>();
  const requests: string[] = [];
  let serial = 0;

  const validJwt = (header: string | undefined) => {
    const [h = "", p = "", s = ""] = (header?.replace(/^Bearer /u, "") ?? "").split(
      ".",
    );
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        keys.publicKey,
        Buffer.from(s, "base64url"),
      )
    )
      return false;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as {
      iss?: string;
      exp?: number;
    };
    return claims.iss === appId && (claims.exp ?? 0) * 1000 > Date.now();
  };
  const bearer = (request: IncomingMessage) =>
    request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
  const view = (installation: FakeGitHubInstallation) => ({
    id: installation.id,
    account: installation.account,
    repository_selection: installation.repositorySelection,
    suspended_at: installation.suspendedAt,
  });

  const fake: FakeGitHubInstallations = {
    webBaseUrl: "",
    apiBaseUrl: "",
    appId,
    appPrivateKeyPem,
    installations,
    callbackUrl: "",
    nextInstall: null,
    requests,
    failures: new Map(),
    addInstallation({ users, ...input }) {
      const installation: FakeGitHubInstallation = {
        ...input,
        memberships: new Map(
          users.map((user) => [user, { state: "active", role: "admin" } as const]),
        ),
        suspendedAt: null,
        removed: false,
      };
      installations.set(installation.id, installation);
      return installation;
    },
    issueCode(user) {
      serial += 1;
      const code = `test-code-${String(serial)}`;
      codes.set(code, user);
      return code;
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      requests.push(`${request.method ?? ""} ${url.pathname}`);
      const send = (status: number, data?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(data === undefined ? "" : JSON.stringify(data));
      };
      const install = /^\/apps\/([a-z0-9-]+)\/installations\/new$/u.exec(url.pathname);
      if (install && request.method === "GET") {
        const next = fake.nextInstall;
        if (!next) return send(404, { message: "Not Found" });
        const target = new URL(fake.callbackUrl);
        target.searchParams.set("installation_id", String(next.installationId));
        target.searchParams.set("setup_action", "install");
        target.searchParams.set("code", fake.issueCode(next.user));
        target.searchParams.set("state", url.searchParams.get("state") ?? "");
        response.writeHead(302, { location: target.toString() });
        response.end();
        return;
      }
      if (url.pathname === "/login/oauth/access_token" && request.method === "POST") {
        // Like GitHub, the exchange answers JSON only to `Accept:
        // application/json` and form-encoded otherwise.
        const oauth = (data: Record<string, string>) => {
          if (request.headers.accept?.includes("application/json"))
            return send(200, data);
          response.writeHead(200, {
            "content-type": "application/x-www-form-urlencoded",
          });
          response.end(new URLSearchParams(data).toString());
        };
        const body = (await readBody(request)) as Record<string, unknown> | null;
        const user = typeof body?.code === "string" ? codes.get(body.code) : undefined;
        if (!user || body?.client_secret !== "test-client-secret-value")
          return oauth({ error: "bad_verification_code" });
        codes.delete(body.code as string);
        serial += 1;
        const token = `test-user-access-token-${String(serial)}`;
        userTokens.set(token, user);
        return oauth({ access_token: token, token_type: "bearer" });
      }
      const api = "/api";
      if (!url.pathname.startsWith(`${api}/`))
        return send(404, { message: "Not Found" });
      const path = url.pathname.slice(api.length);
      const failure = fake.failures.get(`${request.method ?? ""} ${path}`);
      if (failure) {
        response.writeHead(failure.status, {
          "content-type": "application/json",
          ...failure.headers,
        });
        response.end(JSON.stringify(failure.body ?? { message: "Injected failure" }));
        return;
      }
      if (path === "/user" && request.method === "GET") {
        const user = userTokens.get(bearer(request));
        return user
          ? send(200, { login: user })
          : send(401, { message: "Bad credentials" });
      }
      const org = /^\/user\/memberships\/orgs\/([^/]+)$/u.exec(path);
      if (org && request.method === "GET") {
        const user = userTokens.get(bearer(request));
        if (!user) return send(401, { message: "Bad credentials" });
        const login = decodeURIComponent(org[1] ?? "");
        const membership = [...installations.values()]
          .filter((i) => i.account.type === "Organization" && i.account.login === login)
          .map((i) => i.memberships.get(user))
          .find(Boolean);
        return membership
          ? send(200, { ...membership, organization: { login } })
          : send(404, { message: "Not Found" });
      }
      const app = /^\/app\/installations\/([0-9]+)(\/access_tokens)?$/u.exec(path);
      if (app) {
        if (!validJwt(request.headers.authorization))
          return send(401, { message: "Bad JWT" });
        const installation = installations.get(Number(app[1]));
        if (!installation || installation.removed)
          return send(404, { message: "Not Found" });
        if (!app[2] && request.method === "GET") return send(200, view(installation));
        if (app[2] && request.method === "POST") {
          if (installation.suspendedAt) return send(403, { message: "suspended" });
          serial += 1;
          const token = `test-installation-access-${String(serial)}`;
          installationTokens.set(token, installation.id);
          return send(201, {
            token,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { metadata: "read" },
          });
        }
        return send(405, { message: "Method Not Allowed" });
      }
      if (path === "/installation/repositories" && request.method === "GET") {
        const id = installationTokens.get(bearer(request));
        const installation = id === undefined ? undefined : installations.get(id);
        if (!installation || installation.removed)
          return send(401, { message: "Bad credentials" });
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        const page = Number(url.searchParams.get("page") ?? "1");
        return send(200, {
          total_count: installation.repositories.length,
          repositories: installation.repositories
            .slice((page - 1) * perPage, page * perPage)
            .map((r) => ({
              full_name: r.fullName,
              private: r.private,
              default_branch: r.defaultBranch,
            })),
        });
      }
      return send(404, { message: "Not Found" });
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  Object.assign(fake, { webBaseUrl: base, apiBaseUrl: `${base}/api` });
  return fake;
}

/** Runtime bindings that point the API's GitHub App at a fake GitHub. */
export function fakeGitHubAppBindings(fake: FakeGitHubInstallations) {
  return {
    GITHUB_APP_ID: fake.appId,
    GITHUB_APP_PRIVATE_KEY: fake.appPrivateKeyPem,
    GITHUB_APP_WEBHOOK_SECRET: "test-webhook-signing-value-".repeat(2),
    GITHUB_APP_SLUG: "skillplane-test",
    GITHUB_APP_CLIENT_ID: "Iv1.test-client-id",
    GITHUB_APP_CLIENT_SECRET: "test-client-secret-value",
    GITHUB_API_URL: fake.apiBaseUrl,
    GITHUB_WEB_URL: fake.webBaseUrl,
  };
}
