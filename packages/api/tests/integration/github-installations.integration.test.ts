import {
  GitHubApp,
  GitHubInstallationService,
  GitSourceService,
  type GitSnapshot,
  type Principal,
} from "@skillplane/domain";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  fakeGitHubAppBindings,
  purgeTenantFixture,
  seedTenantFixture,
  startFakeGitHubInstallations,
  TestObjectStorage,
  type FakeGitHubInstallations,
  type TenantFixture,
} from "@skillplane/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";

// Install, bind, list and unbind GitHub App installations over HTTP against a
// fake GitHub. Installation IDs are unique per run because the table is
// shared by every integration file using the test database.
const makeSuffix = () => `github-install-${crypto.randomUUID()}`;
const suffixes = [makeSuffix(), makeSuffix(), makeSuffix(), makeSuffix()] as const;
const base = 9_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
let databaseUrl: string;
let github: FakeGitHubInstallations;
let services: ApiServices;
let app: ReturnType<typeof createApiApp>;
let owner: TenantFixture,
  admin: TenantFixture,
  viewer: TenantFixture,
  other: TenantFixture;

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  owner = await seedTenantFixture(databaseUrl, suffixes[0]);
  admin = await seedTenantFixture(databaseUrl, suffixes[1]);
  viewer = await seedTenantFixture(databaseUrl, suffixes[2]);
  other = await seedTenantFixture(databaseUrl, suffixes[3]);
  github = await startFakeGitHubInstallations();
  github.callbackUrl = "http://localhost/github/setup";
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
    ...fakeGitHubAppBindings(github),
  });
  for (const [user, role] of [
    [admin.userId, "admin"],
    [viewer.userId, "viewer"],
  ] as const)
    await services.database.pool.query(
      "INSERT INTO workspace_memberships(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4)",
      [`membership:${crypto.randomUUID()}`, owner.workspaceId, user, role],
    );
  app = createApiApp({ getServices: async () => services });
}, 60_000);

afterAll(async () => {
  await github?.close();
  await services?.datafn.close();
  await services?.email?.close();
  await services?.database.close();
  for (const suffix of suffixes) await purgeTenantFixture(databaseUrl, suffix);
});

function installation(id: number, login: string, users: string[]) {
  return github.addInstallation({
    id,
    account: { login, type: "Organization" },
    repositorySelection: "selected",
    repositories: [
      { fullName: `${login}/private-skills`, private: true, defaultBranch: "main" },
    ],
    users,
  });
}

const auth = (who: TenantFixture, workspaceId = who.workspaceId) => ({
  authorization: `Bearer ${who.sessionToken}`,
  "x-skillplane-workspace-id": workspaceId,
});
const api = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/github`;

async function installState(who: TenantFixture, workspaceId = who.workspaceId) {
  const response = await app.request(`${api(workspaceId)}/install`, {
    headers: auth(who, workspaceId),
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(
    `${github.webBaseUrl}/apps/skillplane-test/installations/new`,
  );
  return location.searchParams.get("state") ?? "";
}

const ownerPrincipal = (): Principal => ({
  kind: "user",
  actorId: owner.userId,
  userId: owner.userId,
  sessionId: "session:test",
  workspaceId: owner.workspaceId,
  role: "owner",
});

async function callback(
  who: TenantFixture,
  query: { state: string; installationId: number; code: string; setupAction?: string },
  path = "/github/setup",
) {
  const params = new URLSearchParams({
    installation_id: String(query.installationId),
    setup_action: query.setupAction ?? "install",
    code: query.code,
    state: query.state,
  });
  const response = await app.request(`${path}?${params.toString()}`, {
    headers: { authorization: `Bearer ${who.sessionToken}` },
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const location = new URL(response.headers.get("location") ?? "", "http://localhost");
  expect(location.pathname).toBe("/settings/github");
  return {
    connected: location.searchParams.get("github_connected"),
    error: location.searchParams.get("github_error"),
  };
}

async function list(who: TenantFixture, workspaceId = who.workspaceId) {
  const response = await app.request(`${api(workspaceId)}/installations`, {
    headers: auth(who, workspaceId),
  });
  expect(response.status).toBe(200);
  return (
    (await response.json()) as {
      data: {
        installable: boolean;
        installations: {
          installationId: number;
          accountLogin: string;
          status: string;
        }[];
      };
    }
  ).data;
}

it("binds an installation the installing owner can access and lists its repositories", async () => {
  const id = base + 1;
  installation(id, "acme-happy", ["octo-owner"]);
  const state = await installState(owner);
  // A pending approval binds nothing and keeps the state usable.
  expect(
    await callback(owner, {
      state,
      installationId: id,
      code: github.issueCode("octo-owner"),
      setupAction: "request",
    }),
  ).toEqual({ connected: null, error: "GITHUB_INSTALL_PENDING_APPROVAL" });
  // The API alias is the callback URL the app forwards.
  expect(
    await callback(
      owner,
      { state, installationId: id, code: github.issueCode("octo-owner") },
      "/api/v1/github/setup",
    ),
  ).toEqual({ connected: String(id), error: null });
  const listed = await list(owner);
  expect(listed.installable).toBe(true);
  expect(listed.installations).toEqual([
    expect.objectContaining({
      installationId: id,
      accountLogin: "acme-happy",
      status: "active",
    }),
  ]);
  const repositories = await app.request(
    `${api(owner.workspaceId)}/installations/${String(id)}/repositories`,
    { headers: auth(owner) },
  );
  expect(repositories.status).toBe(200);
  expect(
    ((await repositories.json()) as { data: { repositories: { fullName: string }[] } })
      .data.repositories,
  ).toEqual([
    expect.objectContaining({ fullName: "acme-happy/private-skills", private: true }),
  ]);
  // Replaying the same callback is refused, and so is a state signed for another
  // workspace, user or deployment.
  expect(
    await callback(owner, {
      state,
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  ).toEqual({ connected: null, error: "GITHUB_INSTALL_STATE_REPLAYED" });
});

it("refuses forged, tampered, foreign-user and expired states before binding", async () => {
  const id = base + 2;
  installation(id, "acme-forged", ["octo-owner", "octo-admin"]);
  const state = await installState(owner);
  const [payload = "", signature = ""] = state.split(".");
  const flipped = `${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
  const claims = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const reworded = `${Buffer.from(JSON.stringify({ ...claims, w: other.workspaceId })).toString("base64url")}.${signature}`;
  for (const forged of [flipped, reworded, "not-a-state", ""])
    expect(
      (
        await callback(owner, {
          state: forged,
          installationId: id,
          code: github.issueCode("octo-owner"),
        })
      ).error,
    ).toBe("GITHUB_INSTALL_STATE_INVALID");
  // Another admin of the same workspace cannot complete the owner's install.
  expect(
    (
      await callback(admin, {
        state,
        installationId: id,
        code: github.issueCode("octo-admin"),
      })
    ).error,
  ).toBe("GITHUB_INSTALL_STATE_INVALID");
  // A state signed with another deployment's secret is refused.
  const foreign = new GitHubInstallationService(services.database.pool, {
    app: new GitHubApp(
      { appId: github.appId, privateKeyPem: github.appPrivateKeyPem },
      { apiBaseUrl: github.apiBaseUrl },
    ),
    settings: services.githubInstallSettings ?? null,
    stateSecret: "another-deployment-state-signing-value",
  });
  const foreignState =
    new URL(
      await foreign.installUrl({
        kind: "user",
        actorId: owner.userId,
        userId: owner.userId,
        sessionId: "session:test",
        workspaceId: owner.workspaceId,
        role: "owner",
      }),
    ).searchParams.get("state") ?? "";
  expect(
    (
      await callback(owner, {
        state: foreignState,
        installationId: id,
        code: github.issueCode("octo-owner"),
      })
    ).error,
  ).toBe("GITHUB_INSTALL_STATE_INVALID");
  // An expired state: issued eleven minutes before the callback.
  const issuedEarly = new GitHubInstallationService(services.database.pool, {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    now: () => Date.now() - 11 * 60 * 1000,
  });
  const expired =
    new URL(
      await issuedEarly.installUrl({
        kind: "user",
        actorId: owner.userId,
        userId: owner.userId,
        sessionId: "session:test",
        workspaceId: owner.workspaceId,
        role: "owner",
      }),
    ).searchParams.get("state") ?? "";
  expect(
    (
      await callback(owner, {
        state: expired,
        installationId: id,
        code: github.issueCode("octo-owner"),
      })
    ).error,
  ).toBe("GITHUB_INSTALL_STATE_INVALID");
  // An API clock eleven minutes behind accepts its own state, but the claim
  // judges expiry by the database clock that prunes consumed nonces.
  const lagging = new GitHubInstallationService(services.database.pool, {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    now: () => Date.now() - 11 * 60 * 1000,
  });
  const lagged =
    new URL(await lagging.installUrl(ownerPrincipal())).searchParams.get("state") ?? "";
  await expect(
    lagging.completeSetup({
      principal: ownerPrincipal(),
      requestId: crypto.randomUUID(),
      state: lagged,
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  ).rejects.toMatchObject({ code: "GITHUB_INSTALL_STATE_INVALID" });
  expect((await list(owner)).installations.map((i) => i.installationId)).not.toContain(
    id,
  );
});

it("trusts only an installation the installing user can access on GitHub", async () => {
  const id = base + 3;
  installation(id, "victim-org", ["victim-user"]);
  // A valid state with someone else's installation_id: GitHub does not list it
  // for this user, so nothing is bound.
  expect(
    await callback(owner, {
      state: await installState(owner),
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  ).toEqual({ connected: null, error: "GITHUB_INSTALLATION_NOT_ACCESSIBLE" });
  expect(
    (
      await callback(owner, {
        state: await installState(owner),
        installationId: id,
        code: "test-code-unknown",
      })
    ).error,
  ).toBe("GITHUB_INSTALLATION_NOT_ACCESSIBLE");
  expect((await list(owner)).installations.map((i) => i.installationId)).not.toContain(
    id,
  );
});

it("refuses an installation bound to another workspace, including concurrent binds", async () => {
  const id = base + 4;
  installation(id, "acme-shared", ["octo-owner", "octo-other"]);
  const [first, second] = await Promise.all([
    installState(owner).then((state) =>
      callback(owner, {
        state,
        installationId: id,
        code: github.issueCode("octo-owner"),
      }),
    ),
    installState(other).then((state) =>
      callback(other, {
        state,
        installationId: id,
        code: github.issueCode("octo-other"),
      }),
    ),
  ]);
  const outcomes = [first, second];
  expect(outcomes.filter((o) => o.connected === String(id))).toHaveLength(1);
  expect(
    outcomes.filter((o) => o.error === "GITHUB_INSTALLATION_BOUND_ELSEWHERE"),
  ).toHaveLength(1);
  const winner = first.connected ? owner : other;
  const loser = first.connected ? other : owner;
  expect((await list(winner)).installations.map((i) => i.installationId)).toContain(id);
  expect((await list(loser)).installations.map((i) => i.installationId)).not.toContain(
    id,
  );
  // The loser still cannot take it later.
  expect(
    (
      await callback(loser, {
        state: await installState(loser),
        installationId: id,
        code: github.issueCode(loser === owner ? "octo-owner" : "octo-other"),
      })
    ).error,
  ).toBe("GITHUB_INSTALLATION_BOUND_ELSEWHERE");
});

it("lets members read installation status but not install or unbind", async () => {
  const id = base + 5;
  installation(id, "acme-members", ["octo-owner"]);
  await callback(owner, {
    state: await installState(owner),
    installationId: id,
    code: github.issueCode("octo-owner"),
  });
  const install = await app.request(`${api(owner.workspaceId)}/install`, {
    headers: auth(viewer, owner.workspaceId),
  });
  expect(install.status).toBe(403);
  const unbind = await app.request(
    `${api(owner.workspaceId)}/installations/${String(id)}`,
    {
      method: "DELETE",
      headers: auth(viewer, owner.workspaceId),
    },
  );
  expect(unbind.status).toBe(403);
  expect(
    (await list(viewer, owner.workspaceId)).installations.map((i) => i.installationId),
  ).toContain(id);
  // An outsider sees nothing of the workspace.
  const outsider = await app.request(`${api(owner.workspaceId)}/installations`, {
    headers: auth(other, owner.workspaceId),
  });
  expect(outsider.status).toBe(404);
});

it("reflects suspension and uninstallation on GitHub when listing", async () => {
  const id = base + 6;
  const fake = installation(id, "acme-status", ["octo-owner"]);
  await callback(owner, {
    state: await installState(owner),
    installationId: id,
    code: github.issueCode("octo-owner"),
  });
  fake.suspendedAt = new Date().toISOString();
  expect(
    (await list(owner)).installations.find((i) => i.installationId === id)?.status,
  ).toBe("suspended");
  fake.suspendedAt = null;
  expect(
    (await list(owner)).installations.find((i) => i.installationId === id)?.status,
  ).toBe("active");
  fake.removed = true;
  expect(
    (await list(owner)).installations.find((i) => i.installationId === id)?.status,
  ).toBe("removed");
  const repositories = await app.request(
    `${api(owner.workspaceId)}/installations/${String(id)}/repositories`,
    { headers: auth(owner) },
  );
  expect(repositories.status).toBe(409);
});

it("unbinding keeps private sources and marks them auth_failed", async () => {
  const id = base + 7;
  installation(id, "acme-unbind", ["octo-owner"]);
  await callback(owner, {
    state: await installState(owner),
    installationId: id,
    code: github.issueCode("octo-owner"),
  });
  const sources = `/api/v1/workspaces/${owner.workspaceId}/sources`;
  const headers = { ...auth(owner), "content-type": "application/json" };
  // The repository must belong to the installation's account.
  const wrongOwner = await app.request(sources, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      repositoryUrl: "https://github.com/someone-else/skills",
      installationId: id,
    }),
  });
  expect(wrongOwner.status).toBe(400);
  const created = await app.request(sources, {
    method: "POST",
    headers: { ...headers, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({
      repositoryUrl: "https://github.com/acme-unbind/private-skills",
      ref: "main",
      installationId: id,
    }),
  });
  expect(created.status).toBe(201);
  const source = (
    (await created.json()) as {
      data: { source: { id: string; installationId: number; authStatus: string } };
    }
  ).data.source;
  expect(source).toMatchObject({ installationId: id, authStatus: "ok" });

  const unbound = await app.request(
    `${api(owner.workspaceId)}/installations/${String(id)}`,
    {
      method: "DELETE",
      headers: auth(owner),
    },
  );
  expect(unbound.status).toBe(200);
  expect(((await unbound.json()) as { data: unknown }).data).toEqual({
    sourcesMarked: 1,
  });
  expect((await list(owner)).installations.map((i) => i.installationId)).not.toContain(
    id,
  );

  const read = await app.request(`${sources}/${encodeURIComponent(source.id)}`, {
    headers: auth(owner),
  });
  expect(read.status).toBe(200);
  expect(
    (
      (await read.json()) as {
        data: { source: { authStatus: string; installationId: number } };
      }
    ).data.source,
  ).toMatchObject({ authStatus: "auth_failed", installationId: id });
  // Syncing an unbound source is refused as auth_failed without reaching GitHub.
  const before = github.requests.length;
  const preview = await app.request(
    `${sources}/${encodeURIComponent(source.id)}/preview`,
    {
      method: "POST",
      headers,
    },
  );
  expect(preview.status).toBe(409);
  expect(((await preview.json()) as { error: { code: string } }).error.code).toBe(
    "GIT_SOURCE_AUTH_FAILED",
  );
  expect(github.requests.slice(before)).toEqual([]);
  // A second unbind finds nothing.
  const again = await app.request(
    `${api(owner.workspaceId)}/installations/${String(id)}`,
    {
      method: "DELETE",
      headers: auth(owner),
    },
  );
  expect(again.status).toBe(404);
});

it("unbinding fences a private source's in-flight preview and apply", async () => {
  const id = base + 8;
  installation(id, "acme-fence", ["octo-owner"]);
  await callback(owner, {
    state: await installState(owner),
    installationId: id,
    code: github.issueCode("octo-owner"),
  });
  // A snapshot that waits until released, read through the bound installation.
  let release: () => void = () => undefined;
  let reached = Promise.resolve();
  const snapshots: number[] = [];
  const hold = () => {
    let entered: () => void = () => undefined;
    reached = new Promise((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    return { entered, gate };
  };
  let held: ReturnType<typeof hold> | null = null;
  const sources = new GitSourceService(
    services.database.pool,
    services.skillService,
    services.skillVersionService,
    { snapshot: () => Promise.reject(new Error("public provider used")) },
    (installationId) => ({
      snapshot: async (): Promise<GitSnapshot> => {
        snapshots.push(installationId);
        held?.entered();
        await held?.gate;
        return { commitSha: "a".repeat(40), skills: [] };
      },
    }),
  );
  const m = () => ({ principal: ownerPrincipal(), requestId: crypto.randomUUID() });
  const creation = {
    idempotencyKey: crypto.randomUUID(),
    config: {
      repositoryUrl: "https://github.com/acme-fence/private-skills",
      ref: "main",
      installationId: id,
    },
  };
  const source = await sources.create({ ...m(), ...creation });
  const run = await sources.preview({ ...m(), sourceId: source.id });
  expect(snapshots).toEqual([id]);
  const unbind = () =>
    app.request(`${api(owner.workspaceId)}/installations/${String(id)}`, {
      method: "DELETE",
      headers: auth(owner),
    });
  const rebind = async () =>
    expect(
      await callback(owner, {
        state: await installState(owner),
        installationId: id,
        code: github.issueCode("octo-owner"),
      }),
    ).toEqual({ connected: String(id), error: null });

  held = hold();
  const applying = sources.apply({ ...m(), sourceId: source.id, runId: run.id });
  await reached;
  expect((await unbind()).status).toBe(200);
  release();
  await expect(applying).rejects.toMatchObject({ code: "GIT_SOURCE_LEASE_LOST" });
  expect((await sources.get(ownerPrincipal(), source.id)).source.authStatus).toBe(
    "auth_failed",
  );

  await rebind();
  held = hold();
  const previewing = sources.preview({ ...m(), sourceId: source.id });
  await reached;
  expect((await unbind()).status).toBe(200);
  release();
  await expect(previewing).rejects.toMatchObject({ code: "CONFLICT" });
  expect((await sources.get(ownerPrincipal(), source.id)).source.authStatus).toBe(
    "auth_failed",
  );
  // A replay of the creation returns the stored source while unbound.
  expect(await sources.create({ ...m(), ...creation })).toMatchObject({
    id: source.id,
    authStatus: "auth_failed",
  });
});

it("reports an unconfigured GitHub App without reaching GitHub", async () => {
  const bare = createApiApp({
    getServices: async () =>
      ({ ...services, githubApp: null, githubInstallSettings: null }) as ApiServices,
  });
  const before = github.requests.length;
  const listed = await bare.request(`${api(owner.workspaceId)}/installations`, {
    headers: auth(owner),
  });
  expect(listed.status).toBe(200);
  expect(
    ((await listed.json()) as { data: { installable: boolean } }).data.installable,
  ).toBe(false);
  const install = await bare.request(`${api(owner.workspaceId)}/install`, {
    headers: auth(owner),
  });
  expect(install.status).toBe(503);
  expect(((await install.json()) as { error: { code: string } }).error.code).toBe(
    "GITHUB_APP_NOT_CONFIGURED",
  );
  expect(github.requests.slice(before)).toEqual([]);
});
