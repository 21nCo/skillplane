import {
  GitHubApp,
  GitHubAuthFailedError,
  GitHubInstallationService,
  GitSourceService,
  GITHUB_INSTALL_STATE_TTL_MS,
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
import type { Pool, PoolClient } from "pg";
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
  // Replaying the same callback is refused without asking GitHub, and so is a
  // state signed for another workspace, user or deployment.
  const exchanges = github.requests.length;
  expect(
    await callback(owner, {
      state,
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  ).toEqual({ connected: null, error: "GITHUB_INSTALL_STATE_REPLAYED" });
  expect(github.requests.length).toBe(exchanges);
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
  const beforeLagged = github.requests.length;
  await expect(
    lagging.completeSetup({
      principal: ownerPrincipal(),
      requestId: crypto.randomUUID(),
      state: lagged,
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  ).rejects.toMatchObject({ code: "GITHUB_INSTALL_STATE_INVALID" });
  // Refused before OAuth.
  expect(github.requests.slice(beforeLagged)).toEqual([]);
  expect((await list(owner)).installations.map((i) => i.installationId)).not.toContain(
    id,
  );
});

it("binds only with installation-admin authority on GitHub", async () => {
  const id = base + 3;
  const org = installation(id, "victim-org", ["victim-user"]);
  org.memberships.set("octo-member", { state: "active", role: "member" });
  org.memberships.set("octo-pending", { state: "pending", role: "admin" });
  // Every refusal leaves the state unused, so one state serves them all and
  // still binds once the user is an admin.
  const shared = await installState(owner);
  const refused = async (user: string, code = github.issueCode(user)) =>
    (
      await callback(owner, {
        state: shared,
        installationId: id,
        code,
      })
    ).error;
  // A collaborator (no membership), a member, a pending admin, an unknown code
  // and a membership check GitHub cannot answer bind nothing.
  for (const user of ["octo-owner", "octo-member", "octo-pending"])
    expect(await refused(user), user).toBe("GITHUB_INSTALLATION_NOT_ACCESSIBLE");
  expect(await refused("octo-owner", "test-code-unknown")).toBe(
    "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
  );
  org.memberships.set("octo-owner", { state: "active", role: "admin" });
  for (const status of [500, 403]) {
    github.failures.set("GET /user/memberships/orgs/victim-org", { status });
    expect(await refused("octo-owner"), String(status)).toBe(
      "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
    );
  }
  github.failures.clear();
  // A User installation binds only for that user's own account.
  const personal = base + 14;
  github.addInstallation({
    id: personal,
    account: { login: "octo-solo", type: "User" },
    repositorySelection: "all",
    repositories: [],
    users: ["octo-owner"],
  });
  expect(
    (
      await callback(owner, {
        state: await installState(owner),
        installationId: personal,
        code: github.issueCode("octo-owner"),
      })
    ).error,
  ).toBe("GITHUB_INSTALLATION_NOT_ACCESSIBLE");
  const listed = (await list(owner)).installations.map((i) => i.installationId);
  expect(listed).not.toContain(id);
  expect(listed).not.toContain(personal);
  // Neither discovery nor a private source can use a refused binding.
  const discovery = await app.request(
    `${api(owner.workspaceId)}/installations/${String(id)}/repositories`,
    { headers: auth(owner) },
  );
  expect(discovery.status).toBe(409);
  const source = await app.request(`/api/v1/workspaces/${owner.workspaceId}/sources`, {
    method: "POST",
    headers: {
      ...auth(owner),
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      repositoryUrl: "https://github.com/victim-org/private-skills",
      installationId: id,
    }),
  });
  expect(source.status).toBe(400);
  expect(
    await callback(owner, {
      state: await installState(owner),
      installationId: personal,
      code: github.issueCode("octo-solo"),
    }),
  ).toEqual({ connected: String(personal), error: null });
  expect(
    await callback(owner, {
      state: shared,
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  ).toEqual({ connected: String(id), error: null });
  for (const bound of [id, personal]) expect((await unbind(bound)).status).toBe(200);
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
  // The loser still cannot take it later, and its refused state stays unused.
  const later = await installState(loser);
  expect(
    (
      await callback(loser, {
        state: later,
        installationId: id,
        code: github.issueCode(loser === owner ? "octo-owner" : "octo-other"),
      })
    ).error,
  ).toBe("GITHUB_INSTALLATION_BOUND_ELSEWHERE");
  expect(await nonceRows(later)).toBe(0);
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

// A source service whose installation snapshots wait while `held` is set and
// then succeed, or fail as revoked access when `held.fail` is set.
function heldSources() {
  const control = {
    held: null as null | { entered: () => void; gate: Promise<void>; fail: boolean },
    release: (() => undefined) as () => void,
    reached: Promise.resolve(),
    snapshots: [] as number[],
    hold(fail = false) {
      let entered: () => void = () => undefined;
      control.reached = new Promise((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (control.release = resolve));
      control.held = { entered, gate, fail };
    },
  };
  const sources = new GitSourceService(
    services.database.pool,
    services.skillService,
    services.skillVersionService,
    { snapshot: () => Promise.reject(new Error("public provider used")) },
    (installationId) => ({
      snapshot: async (): Promise<GitSnapshot> => {
        control.snapshots.push(installationId);
        const held = control.held;
        held?.entered();
        await held?.gate;
        if (held?.fail) throw new GitHubAuthFailedError();
        return { commitSha: "a".repeat(40), skills: [] };
      },
    }),
  );
  return { control, sources };
}

const m = () => ({ principal: ownerPrincipal(), requestId: crypto.randomUUID() });

async function bind(id: number) {
  expect(
    await callback(owner, {
      state: await installState(owner),
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  ).toEqual({ connected: String(id), error: null });
}

const unbind = (id: number) =>
  app.request(`${api(owner.workspaceId)}/installations/${String(id)}`, {
    method: "DELETE",
    headers: auth(owner),
  });

const status = async (id: number) =>
  (await list(owner)).installations.find((i) => i.installationId === id)?.status;

it("unbinding fences a private source's in-flight preview and apply", async () => {
  const id = base + 8;
  installation(id, "acme-fence", ["octo-owner"]);
  await bind(id);
  const { control, sources } = heldSources();
  const authStatus = async () =>
    (await sources.get(ownerPrincipal(), source.id)).source.authStatus;
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
  expect(control.snapshots).toEqual([id]);

  control.hold();
  const applying = sources.apply({ ...m(), sourceId: source.id, runId: run.id });
  await control.reached;
  expect((await unbind(id)).status).toBe(200);
  control.release();
  await expect(applying).rejects.toMatchObject({ code: "GIT_SOURCE_LEASE_LOST" });
  expect(await authStatus()).toBe("auth_failed");

  await bind(id);
  control.hold();
  const previewing = sources.preview({ ...m(), sourceId: source.id });
  await control.reached;
  expect((await unbind(id)).status).toBe(200);
  control.release();
  await expect(previewing).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await authStatus()).toBe("auth_failed");

  // A preview that fails as revoked after the source was unbound, bound again
  // and synced does not mark the recovered source.
  await bind(id);
  control.hold(true);
  const failing = sources.preview({ ...m(), sourceId: source.id });
  await control.reached;
  control.held = null;
  expect((await unbind(id)).status).toBe(200);
  await bind(id);
  await sources.preview({ ...m(), sourceId: source.id });
  expect(await authStatus()).toBe("ok");
  control.release();
  await expect(failing).rejects.toMatchObject({ code: "GIT_SOURCE_AUTH_FAILED" });
  expect(await authStatus()).toBe("ok");
  expect((await unbind(id)).status).toBe(200);
  // A replay of the creation returns the stored source while unbound.
  expect(await sources.create({ ...m(), ...creation })).toMatchObject({
    id: source.id,
    authStatus: "auth_failed",
  });
});

it("suspension or removal seen when listing fences in-flight preview and apply", async () => {
  const id = base + 9;
  const fake = installation(id, "acme-list-fence", ["octo-owner"]);
  await bind(id);
  const { control, sources } = heldSources();
  const source = await sources.create({
    ...m(),
    idempotencyKey: crypto.randomUUID(),
    config: {
      repositoryUrl: "https://github.com/acme-list-fence/private-skills",
      ref: "main",
      installationId: id,
    },
  });
  const run = await sources.preview({ ...m(), sourceId: source.id });

  control.hold();
  const applying = sources.apply({ ...m(), sourceId: source.id, runId: run.id });
  await control.reached;
  fake.suspendedAt = new Date().toISOString();
  expect(await status(id)).toBe("suspended");
  control.release();
  await expect(applying).rejects.toMatchObject({ code: "GIT_SOURCE_LEASE_LOST" });
  expect((await sources.get(ownerPrincipal(), source.id)).source.authStatus).toBe(
    "auth_failed",
  );

  fake.suspendedAt = null;
  expect(await status(id)).toBe("active");
  control.hold();
  const previewing = sources.preview({ ...m(), sourceId: source.id });
  await control.reached;
  fake.removed = true;
  expect(await status(id)).toBe("removed");
  control.release();
  await expect(previewing).rejects.toMatchObject({ code: "CONFLICT" });
});

it("keeps the newest GitHub observation when refreshes and binds overlap", async () => {
  const id = base + 10;
  const fake = installation(id, "acme-stale", ["octo-owner"]);
  await bind(id);
  // A service whose next installation fetch from GitHub, once answered,
  // waits until released.
  let release: () => void = () => undefined;
  let reached = Promise.resolve();
  let pending: { entered: () => void; gate: Promise<void> } | null = null;
  const holdNext = () => {
    let entered: () => void = () => undefined;
    reached = new Promise((resolve) => (entered = resolve));
    pending = { entered, gate: new Promise<void>((resolve) => (release = resolve)) };
  };
  const held = new GitHubInstallationService(services.database.pool, {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    fetcher: async (input, init) => {
      const response = await fetch(input, init);
      const hold = pending;
      if (hold && String(input).endsWith(`/app/installations/${String(id)}`)) {
        pending = null;
        hold.entered();
        await hold.gate;
      }
      return response;
    },
  });
  const statusIn = (rows: { installationId: number; status: string }[]) =>
    rows.find((i) => i.installationId === id)?.status;

  // An older suspended observation does not overwrite a newer active one.
  fake.suspendedAt = new Date().toISOString();
  holdNext();
  const stale = held.list(m());
  await reached;
  fake.suspendedAt = null;
  expect(await status(id)).toBe("active");
  release();
  expect(statusIn(await stale)).toBe("active");
  expect(await status(id)).toBe("active");

  // Nor does it land on the row an unbind and a new bind created meanwhile.
  fake.suspendedAt = new Date().toISOString();
  holdNext();
  const across = held.list(m());
  await reached;
  expect((await unbind(id)).status).toBe(200);
  fake.suspendedAt = null;
  await bind(id);
  release();
  expect(statusIn(await across)).toBe("active");

  // A bind whose observation is older than a refresh keeps the refresh.
  const state = await installState(owner);
  fake.suspendedAt = new Date().toISOString();
  holdNext();
  const binding = held.completeSetup({
    ...m(),
    state,
    installationId: id,
    code: github.issueCode("octo-owner"),
  });
  await reached;
  fake.suspendedAt = null;
  expect(await status(id)).toBe("active");
  release();
  expect((await binding).status).toBe("active");
  expect(await status(id)).toBe("active");
});

it("caps a workspace's installations and flags a truncated repository list", async () => {
  // Fill another workspace up to the cap directly.
  const bound = await services.database.pool.query<{ count: string }>(
    "SELECT count(*) AS count FROM github_installations WHERE workspace_id=$1",
    [other.workspaceId],
  );
  for (let i = Number(bound.rows[0]?.count ?? 0); i < 20; i += 1)
    await services.database.pool.query(
      "INSERT INTO github_installations(installation_id,workspace_id,account_login,account_type,repository_selection,bound_by) VALUES($1,$2,$3,'Organization','all',$4)",
      [base + 100 + i, other.workspaceId, `acme-filler-${String(i)}`, other.userId],
    );
  const id = base + 11;
  const fake = github.addInstallation({
    id,
    account: { login: "acme-cap", type: "Organization" },
    repositorySelection: "all",
    repositories: [],
    users: ["octo-other", "octo-owner"],
  });
  const capped = await installState(other);
  expect(
    await callback(other, {
      state: capped,
      installationId: id,
      code: github.issueCode("octo-other"),
    }),
  ).toEqual({ connected: null, error: "GITHUB_INSTALLATION_LIMIT_REACHED" });
  expect(await nonceRows(capped)).toBe(0);
  expect((await list(other)).installations).toHaveLength(20);

  // A repository list longer than the listing reads says it is truncated.
  fake.repositories = Array.from({ length: 501 }, (_, i) => ({
    fullName: `acme-cap/skills-${String(i)}`,
    private: true,
    defaultBranch: "main",
  }));
  await bind(id);
  const repositories = await app.request(
    `${api(owner.workspaceId)}/installations/${String(id)}/repositories`,
    { headers: auth(owner) },
  );
  expect(repositories.status).toBe(200);
  interface Listing {
    data: { repositories: unknown[]; truncated: boolean; nextCursor: string | null };
  }
  const listing = ((await repositories.json()) as Listing).data;
  expect(listing.repositories).toHaveLength(500);
  expect(listing).toMatchObject({ truncated: true, nextCursor: "6" });
  // The cursor reads on to the end.
  const rest = await repositoriesOf(id, "?cursor=6");
  expect(rest.status).toBe(200);
  expect(((await rest.json()) as Listing).data).toMatchObject({
    repositories: [expect.objectContaining({ fullName: "acme-cap/skills-500" })],
    truncated: false,
    nextCursor: null,
  });
  expect((await repositoriesOf(id, "?cursor=0")).status).toBe(400);
  // GitHub's next link decides: an understated total_count still reads on...
  fake.totalCount = 100;
  const understated = ((await (await repositoriesOf(id)).json()) as Listing).data;
  expect(understated).toMatchObject({ truncated: true, nextCursor: "6" });
  delete fake.totalCount;
  // ...and exactly five full pages are the whole listing.
  fake.repositories = fake.repositories.slice(0, 500);
  const exact = ((await (await repositoriesOf(id)).json()) as Listing).data;
  expect(exact.repositories).toHaveLength(500);
  expect(exact).toMatchObject({ truncated: false, nextCursor: null });
  // A full page followed by a short one ends the listing.
  fake.repositories = fake.repositories.slice(0, 150);
  const whole = await repositoriesOf(id);
  const all = ((await whole.json()) as Listing).data;
  expect(all.repositories).toHaveLength(150);
  expect(all).toMatchObject({ truncated: false, nextCursor: null });
});

it("keeps consumed install states until well past their expiry", async () => {
  const nonce = (label: string) => `test-consumed-nonce-${label}-${String(base)}`;
  await services.database.pool.query(
    "INSERT INTO github_installation_states(nonce,workspace_id,expires_at) VALUES($1,$3,now()-interval '1 minute'),($2,$3,now()-interval '2 days')",
    [nonce("recent"), nonce("old"), owner.workspaceId],
  );
  const id = base + 12;
  installation(id, "acme-retention", ["octo-owner"]);
  await bind(id);
  const kept = await services.database.pool.query<{ nonce: string }>(
    "SELECT nonce FROM github_installation_states WHERE nonce = ANY($1)",
    [[nonce("recent"), nonce("old")]],
  );
  expect(kept.rows.map((row) => row.nonce)).toEqual([nonce("recent")]);
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

it("reads bound installations when only the App is configured", async () => {
  const id = base + 13;
  const fake = installation(id, "acme-app-only", ["octo-owner"]);
  await bind(id);
  const appOnly = createApiApp({
    getServices: async () =>
      ({ ...services, githubInstallSettings: null }) as ApiServices,
  });
  fake.suspendedAt = new Date().toISOString();
  const listed = await appOnly.request(`${api(owner.workspaceId)}/installations`, {
    headers: auth(owner),
  });
  expect(listed.status).toBe(200);
  const data = (
    (await listed.json()) as {
      data: {
        installable: boolean;
        installations: { installationId: number; status: string }[];
      };
    }
  ).data;
  expect(data.installable).toBe(false);
  expect(data.installations.find((i) => i.installationId === id)?.status).toBe(
    "suspended",
  );
  fake.suspendedAt = null;
  expect(
    (await list(owner)).installations.find((i) => i.installationId === id)?.status,
  ).toBe("active");
  const repositories = await appOnly.request(
    `${api(owner.workspaceId)}/installations/${String(id)}/repositories`,
    { headers: auth(owner) },
  );
  expect(repositories.status).toBe(200);
  const install = await appOnly.request(`${api(owner.workspaceId)}/install`, {
    headers: auth(owner),
  });
  expect(install.status).toBe(503);
  expect(((await install.json()) as { error: { code: string } }).error.code).toBe(
    "GITHUB_APP_NOT_CONFIGURED",
  );
});

// A service whose first GitHub request matching `matches` waits, once
// answered (or, with `before`, before it is sent), until released.
function heldInstallations(matches: (url: string) => boolean, before = false) {
  const control = {
    reached: Promise.resolve(),
    release: (() => undefined) as () => void,
    armed: null as null | { entered: () => void; gate: Promise<void> },
    arm() {
      let entered: () => void = () => undefined;
      control.reached = new Promise((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (control.release = resolve));
      control.armed = { entered, gate };
    },
  };
  const wait = async (url: string) => {
    const armed = control.armed;
    if (!armed || !matches(url)) return;
    control.armed = null;
    armed.entered();
    await armed.gate;
  };
  const service = new GitHubInstallationService(services.database.pool, {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    fetcher: async (input, init) => {
      if (before) await wait(String(input));
      const response = await fetch(input, init);
      if (!before) await wait(String(input));
      return response;
    },
  });
  return { control, service };
}

const repositoriesOf = (id: number, query = "") =>
  app.request(
    `${api(owner.workspaceId)}/installations/${String(id)}/repositories${query}`,
    { headers: auth(owner) },
  );
const errorCode = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

it("consumes nothing for a HEAD, an ambiguous callback or another routed workspace", async () => {
  const id = base + 15;
  installation(id, "acme-setup-routing", ["octo-owner"]);
  const state = await installState(owner);
  const query = (extra = "") =>
    `installation_id=${String(id)}&setup_action=install&code=${github.issueCode("octo-owner")}&state=${state}${extra}`;
  const headers = { authorization: `Bearer ${owner.sessionToken}` };
  const location = async (response: Promise<Response>) => {
    const answered = await response;
    expect(answered.status).toBe(302);
    expect(answered.headers.get("cache-control")).toBe("no-store");
    return answered.headers.get("location");
  };
  const invalid = "/settings/github?github_error=GITHUB_INSTALL_STATE_INVALID";
  for (const path of ["/github/setup", "/api/v1/github/setup"])
    expect(
      await location(app.request(`${path}?${query()}`, { method: "HEAD", headers })),
    ).toBe("/settings/github");
  for (const target of [
    `/github/setup?${query(`&state=${state}`)}`,
    `/github/setup?${query("&code=test-code-other")}`,
    `/github/%73etup?${query()}`,
  ])
    expect(await location(app.request(target, { headers })), target).toBe(invalid);
  const as = (deploymentRole: ApiServices["deploymentRole"]) =>
    createApiApp({
      getServices: async () => ({ ...services, deploymentRole }) as ApiServices,
    });
  for (const [role, routed] of [
    ["cell", other.workspaceId],
    ["cell", null],
    ["gateway", null],
  ] as const)
    expect(
      await location(
        as(role).request(`/github/setup?${query()}`, {
          headers: {
            ...headers,
            ...(routed ? { "x-skillplane-routed-workspace-id": routed } : {}),
          },
        }),
      ),
      `${role} ${String(routed)}`,
    ).toBe(invalid);
  // The state is still unused: the cell routed for its workspace binds.
  expect(
    await location(
      as("cell").request(`/api/v1/github/setup?${query()}`, {
        headers: { ...headers, "x-skillplane-routed-workspace-id": owner.workspaceId },
      }),
    ),
  ).toBe(`/settings/github?github_connected=${String(id)}`);
  expect((await unbind(id)).status).toBe(200);
});

const pool = () => services.database.pool;
const setupService = (now?: () => number, database: Pool = pool(), leaseMs?: number) =>
  new GitHubInstallationService(database, {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    ...(now ? { now } : {}),
    ...(leaseMs ? { leaseMs } : {}),
  });
const oauthExchanges = () =>
  github.requests.filter((r) => r === "POST /login/oauth/access_token").length;
const nonceOf = (state: string) =>
  (
    JSON.parse(
      Buffer.from(state.split(".")[0] ?? "", "base64url").toString("utf8"),
    ) as {
      n: string;
    }
  ).n;
const nonceRows = async (state: string) =>
  (
    await pool().query("SELECT 1 FROM github_installation_states WHERE nonce=$1", [
      nonceOf(state),
    ])
  ).rowCount;

/** A state that expires `ms` from now. */
async function expiringState(ms: number) {
  const expiresAt = Date.now() + ms;
  const issuer = setupService(() => expiresAt - GITHUB_INSTALL_STATE_TTL_MS);
  const state =
    new URL(await issuer.installUrl(ownerPrincipal())).searchParams.get("state") ?? "";
  return { state, expiresAt };
}

/** Polls `check` for up to 15 s, failing early once `settled` says the callback ended. */
async function until(
  what: string,
  check: () => Promise<boolean>,
  settled: () => boolean,
) {
  for (const deadline = Date.now() + 15_000; !(await check());) {
    if (settled()) throw new Error(`The callback ended before ${what}`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Resolves once PostgreSQL shows `count` sessions waiting on `holder`. */
async function blockedBy(holder: PoolClient, settled: () => boolean, count = 1) {
  const pid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
    .rows[0]?.pid;
  await until(
    `${String(count)} waiters`,
    async () =>
      Number(
        (
          await pool().query<{ n: string }>(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
            [pid],
          )
        ).rows[0]?.n,
      ) >= count,
    settled,
  );
}

/** Resolves once the database clock is past `at`. */
const databasePast = (at: number) =>
  until(
    "the state's expiry",
    async () =>
      (
        await pool().query<{ past: boolean }>(
          "SELECT clock_timestamp() > $1::timestamptz AS past",
          [new Date(at)],
        )
      ).rows[0]?.past === true,
    () => false,
  );

/** A pending outcome and whether it has settled. */
function track<T>(promise: Promise<T>) {
  let settled = false;
  const outcome = promise.then(
    (value) => ((settled = true), value),
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );
  outcome.catch(() => undefined);
  return { outcome, settled: () => settled };
}

it.each(["ROLLBACK", "COMMIT"])(
  "refuses a state that expires while its claim waits, then %s",
  async (ending) => {
    const id = base + (ending === "COMMIT" ? 30 : 16);
    installation(id, `acme-expiry-${ending.toLowerCase()}`, ["octo-owner"]);
    const { state, expiresAt } = await expiringState(3000);
    const blocker = await pool().connect();
    let claim: ReturnType<typeof track> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "INSERT INTO github_installation_states(nonce,workspace_id,expires_at) VALUES($1,$2,now()+interval '1 minute')",
        [nonceOf(state), owner.workspaceId],
      );
      const before = github.requests.length;
      // A 1 s budget (4 s lease): the 3 s state fails only because of the wait.
      claim = track(
        setupService(undefined, pool(), 4000).completeSetup({
          ...m(),
          state,
          installationId: id,
          code: github.issueCode("octo-owner"),
        }),
      );
      // The claim waits on the uncommitted nonce until the state has expired;
      // expired is reported even when the other claim keeps the nonce.
      await blockedBy(blocker, claim.settled);
      await databasePast(expiresAt);
      await blocker.query(ending);
      await expect(claim.outcome).rejects.toMatchObject({
        code: "GITHUB_INSTALL_STATE_INVALID",
      });
      // GitHub was never asked, nothing is bound and this claim recorded nothing.
      expect(github.requests.slice(before)).toEqual([]);
      expect(await status(id)).toBeUndefined();
      expect(await nonceRows(state)).toBe(ending === "COMMIT" ? 1 : 0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await claim?.outcome.catch(() => undefined);
    }
  },
  30_000,
);

it("lets only one of two duplicate callbacks exchange the code and bind", async () => {
  const id = base + 24;
  installation(id, "acme-duplicate", ["octo-owner"]);
  const state = await installState(owner);
  const blocker = await pool().connect();
  let outcomes: ReturnType<typeof track> | undefined;
  try {
    // Both callbacks reach the nonce while another claim holds it uncommitted.
    await blocker.query("BEGIN");
    await blocker.query(
      "INSERT INTO github_installation_states(nonce,workspace_id,expires_at) VALUES($1,$2,now()+interval '1 minute')",
      [nonceOf(state), owner.workspaceId],
    );
    const before = oauthExchanges();
    const code = github.issueCode("octo-owner");
    outcomes = track(
      Promise.all(
        [0, 1].map(() =>
          setupService()
            .completeSetup({ ...m(), state, installationId: id, code })
            .then(
              () => "bound",
              (error: { code?: string }) => error.code,
            ),
        ),
      ),
    );
    await blockedBy(blocker, outcomes.settled, 2);
    await blocker.query("ROLLBACK");
    expect(((await outcomes.outcome) as string[]).sort()).toEqual([
      "GITHUB_INSTALL_STATE_REPLAYED",
      "bound",
    ]);
    expect(oauthExchanges() - before).toBe(1);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await outcomes?.outcome.catch(() => undefined);
  }
  expect((await unbind(id)).status).toBe(200);
}, 30_000);

it("rolls back a bind whose state expires while it waits for the bind locks", async () => {
  const id = base + 25;
  installation(id, "acme-lock-expiry", ["octo-owner"]);
  const { state, expiresAt } = await expiringState(3000);
  const mutation = m();
  const lock = `github-installations:${owner.workspaceId}`;
  const holder = await pool().connect();
  let claim: ReturnType<typeof track> | undefined;
  try {
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
    // A 4 s lease leaves a 1 s request budget, inside the state's 3 s.
    claim = track(
      setupService(undefined, pool(), 4000).completeSetup({
        ...mutation,
        state,
        installationId: id,
        code: github.issueCode("octo-owner"),
      }),
    );
    await blockedBy(holder, claim.settled);
    await databasePast(expiresAt);
    await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]);
    await expect(claim.outcome).rejects.toMatchObject({
      code: "GITHUB_INSTALL_STATE_INVALID",
    });
  } finally {
    await holder.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
    holder.release();
    await claim?.outcome.catch(() => undefined);
  }
  expect(await status(id)).toBeUndefined();
  expect(await nonceRows(state)).toBe(0);
  const audited = await pool().query("SELECT 1 FROM audit_events WHERE request_id=$1", [
    mutation.requestId,
  ]);
  expect(audited.rowCount).toBe(0);
}, 30_000);

/** Moves the owner's workspace to `activeEpoch`, as a regional cutover does. */
const epoch = (activeEpoch: number) =>
  pool().query(
    `INSERT INTO regional_workspace_migration_fences(workspace_id,source_epoch,active_epoch)
     VALUES($1,0,$2) ON CONFLICT (workspace_id) DO UPDATE SET active_epoch=$2`,
    [owner.workspaceId, activeEpoch],
  );
/** Whether a callback holds the state's nonce on a lease (not consumed). */
const leased = async (state: string) =>
  (
    await pool().query(
      "SELECT 1 FROM github_installation_states WHERE nonce=$1 AND consumed_at > expires_at",
      [nonceOf(state)],
    )
  ).rowCount === 1;
/** Moves a live lease past its deadline, as time would, in the active cell. */
async function expireLease(state: string) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('skillplane.workspace_routing_epoch','2',true)",
    );
    await client.query(
      "UPDATE github_installation_states SET consumed_at=consumed_at - interval '1 hour' WHERE nonce=$1 AND consumed_at > expires_at",
      [nonceOf(state)],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}
/** A callback held right before its OAuth exchange, as if it had crashed. */
async function stalledSetup(state: string, id: number) {
  const { control, service } = heldInstallations(
    (url) => url.endsWith("/login/oauth/access_token"),
    true,
  );
  control.arm();
  const mutation = m();
  const setup = track(
    service.completeSetup({
      ...mutation,
      state,
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  );
  await control.reached;
  const audited = async () =>
    (
      await pool().query("SELECT 1 FROM audit_events WHERE request_id=$1", [
        mutation.requestId,
      ])
    ).rowCount;
  return { setup, release: () => control.release(), audited };
}
const setupAs = (
  state: string,
  id: number,
  fencingEpoch?: number,
  requestId = crypto.randomUUID(),
  code = github.issueCode("octo-owner"),
) =>
  setupService()
    .completeSetup({
      ...m(),
      requestId,
      ...(fencingEpoch ? { fencingEpoch } : {}),
      state,
      installationId: id,
      code,
    })
    .then(
      () => "bound",
      (error: { code?: string }) => error.code,
    );

it("lets a stranded lease expire, and never a lease's former owner bind", async () => {
  const id = base + 27;
  installation(id, "acme-stranded", ["octo-owner"]);
  const state = await installState(owner);
  const stranded = await stalledSetup(state, id);
  try {
    // A live lease refuses another callback without asking GitHub.
    expect(await leased(state)).toBe(true);
    const before = github.requests.length;
    expect(await setupAs(state, id)).toBe("GITHUB_INSTALL_STATE_REPLAYED");
    expect(github.requests.slice(before)).toEqual([]);
    // Once it expires, a new callback takes the lease over and binds...
    await expireLease(state);
    const next = await stalledSetup(state, id);
    // ...while the stranded original, resuming, binds and audits nothing.
    stranded.release();
    await expect(stranded.setup.outcome).rejects.toMatchObject({
      code: "GITHUB_INSTALL_STATE_INVALID",
    });
    expect(await stranded.audited()).toBe(0);
    expect(await status(id)).toBeUndefined();
    next.release();
    expect(await next.setup.outcome).toMatchObject({ installationId: id });
    // A consumed nonce is never taken over, however long ago it was used.
    await pool().query(
      "UPDATE github_installation_states SET consumed_at=consumed_at - interval '1 hour' WHERE nonce=$1",
      [nonceOf(state)],
    );
    const after = github.requests.length;
    expect(await setupAs(state, id)).toBe("GITHUB_INSTALL_STATE_REPLAYED");
    expect(github.requests.slice(after)).toEqual([]);
  } finally {
    stranded.release();
    await stranded.setup.outcome.catch(() => undefined);
  }
  expect((await unbind(id)).status).toBe(200);
}, 30_000);

/** The pool, with queries containing `sql` (or their replies) held until released. */
function pausedBefore(sql: string, reply = false) {
  let entered: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const paused = new Proxy(pool(), {
    get(target, key) {
      if (key === "query")
        return async (text: string, values?: unknown[]) => {
          if (!text.includes(sql)) return target.query(text, values);
          const result = reply ? await target.query(text, values) : undefined;
          entered();
          await gate;
          return result ?? target.query(text, values);
        };
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { pool: paused, reached, release: () => release() };
}

/** Resolves once the database clock is within `ms` of the state's lease deadline. */
const leasePast = (state: string, ms = 0) =>
  until(
    "the lease's deadline",
    async () =>
      (
        await pool().query<{ past: boolean }>(
          "SELECT consumed_at - interval '8760000 hours' - $2::double precision * interval '1 millisecond' < clock_timestamp() AS past FROM github_installation_states WHERE nonce=$1",
          [nonceOf(state), ms],
        )
      ).rows[0]?.past === true,
    () => false,
  );

it("spends the code only while the state and its lease outlive the request budget", async () => {
  const id = base + 38;
  installation(id, "acme-budget", ["octo-owner"]);
  // Less than the default 45 s budget left on the state spends nothing.
  const near = await expiringState(30_000);
  const before = github.requests.length;
  expect(await setupAs(near.state, id)).toBe("GITHUB_INSTALL_STATE_INVALID");
  expect(github.requests.slice(before)).toEqual([]);
  expect(await nonceRows(near.state)).toBe(0);
  // A reply that arrives with less than the budget (1 s of a 4 s lease) left
  // on the state, or on the lease, spends nothing either.
  const leaseMs = 4000;
  const { state, expiresAt } = await expiringState(3000);
  for (const [claimed, late, refused] of [
    [state, () => databasePast(expiresAt - 900), "GITHUB_INSTALL_STATE_INVALID"],
    [near.state, () => leasePast(near.state, 900), "GITHUB_INSTALL_STATE_REPLAYED"],
  ] as const) {
    const slow = pausedBefore("AS fresh", true);
    const claim = track(
      setupService(undefined, slow.pool, leaseMs).completeSetup({
        ...m(),
        state: claimed,
        installationId: id,
        code: github.issueCode("octo-owner"),
      }),
    );
    await slow.reached;
    await late();
    slow.release();
    await expect(claim.outcome).rejects.toMatchObject({ code: refused });
  }
  expect(github.requests.slice(before)).toEqual([]);
}, 30_000);

it.each(["state", "lease"])(
  "rolls back a bind whose %s expires while it waits for the nonce row",
  async (deadline) => {
    const id = base + (deadline === "state" ? 39 : 40);
    installation(id, `acme-nonce-${deadline}`, ["octo-owner"]);
    const expiring = deadline === "state" ? await expiringState(3000) : null;
    const state = expiring?.state ?? (await installState(owner));
    const mutation = m();
    const lock = `github-installations:${owner.workspaceId}`;
    const gate = await pool().connect();
    const holder = await pool().connect();
    let claim: ReturnType<typeof track> | undefined;
    try {
      // The bind waits for the workspace lock while a lock-only transaction
      // takes the nonce row, then waits on that row across the deadline.
      await gate.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
      claim = track(
        setupService(
          undefined,
          pool(),
          deadline === "state" ? 4000 : 3000,
        ).completeSetup({
          ...mutation,
          state,
          installationId: id,
          code: github.issueCode("octo-owner"),
        }),
      );
      await blockedBy(gate, claim.settled);
      await holder.query("BEGIN");
      await holder.query(
        "SELECT 1 FROM github_installation_states WHERE nonce=$1 FOR UPDATE",
        [nonceOf(state)],
      );
      await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]);
      await blockedBy(holder, claim.settled);
      if (expiring) await databasePast(expiring.expiresAt);
      else await leasePast(state);
      await holder.query("COMMIT");
      await expect(claim.outcome).rejects.toMatchObject({
        code: "GITHUB_INSTALL_STATE_INVALID",
      });
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await gate.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
      holder.release();
      gate.release();
      await claim?.outcome.catch(() => undefined);
    }
    expect(await status(id)).toBeUndefined();
    expect(await nonceRows(state)).toBe(0);
    const audited = await pool().query(
      "SELECT 1 FROM audit_events WHERE request_id=$1",
      [mutation.requestId],
    );
    expect(audited.rowCount).toBe(0);
  },
  30_000,
);

it("binds only while its lease lives", async () => {
  const id = base + 35;
  installation(id, "acme-lease-time", ["octo-owner"]);
  const leaseMs = 3000;
  const state = await installState(owner);
  // A lease that runs out while the bind waits for its locks, with no
  // other callback taking it over, binds and audits nothing.
  const mutation = m();
  const lock = `github-installations:${owner.workspaceId}`;
  const holder = await pool().connect();
  let claim: ReturnType<typeof track> | undefined;
  try {
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [lock]);
    claim = track(
      setupService(undefined, pool(), leaseMs).completeSetup({
        ...mutation,
        state,
        installationId: id,
        code: github.issueCode("octo-owner"),
      }),
    );
    await blockedBy(holder, claim.settled);
    await leasePast(state);
    await holder.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock]);
    await expect(claim.outcome).rejects.toMatchObject({
      code: "GITHUB_INSTALL_STATE_INVALID",
    });
  } finally {
    await holder.query("SELECT pg_advisory_unlock_all()").catch(() => undefined);
    holder.release();
    await claim?.outcome.catch(() => undefined);
  }
  expect(await status(id)).toBeUndefined();
  const audited = await pool().query("SELECT 1 FROM audit_events WHERE request_id=$1", [
    mutation.requestId,
  ]);
  expect(audited.rowCount).toBe(0);
}, 30_000);

it("refuses a state that expires while its checks wait, before OAuth", async () => {
  const id = base + 36;
  installation(id, "acme-check-expiry", ["octo-owner"]);
  const { state, expiresAt } = await expiringState(2000);
  const pause = pausedBefore("AS fresh");
  const before = github.requests.length;
  // A 1 s budget (4 s lease): the 2 s state fails only because of the wait.
  const claim = track(
    setupService(undefined, pause.pool, 4000).completeSetup({
      ...m(),
      state,
      installationId: id,
      code: github.issueCode("octo-owner"),
    }),
  );
  await pause.reached;
  await databasePast(expiresAt);
  pause.release();
  await expect(claim.outcome).rejects.toMatchObject({
    code: "GITHUB_INSTALL_STATE_INVALID",
  });
  expect(github.requests.slice(before)).toEqual([]);
  expect(await nonceRows(state)).toBe(0);
  expect(await status(id)).toBeUndefined();
}, 30_000);

it("stops a callback whose lease was taken over before it spends the code", async () => {
  const id = base + 33;
  installation(id, "acme-interrupted", ["octo-owner"]);
  const state = await installState(owner);
  const code = github.issueCode("octo-owner");
  // The callback stalls after its lease committed, before its checks.
  const pause = pausedBefore("AS fresh");
  const original = track(
    setupService(undefined, pause.pool).completeSetup({
      ...m(),
      state,
      installationId: id,
      code,
    }),
  );
  try {
    await pause.reached;
    expect(await leased(state)).toBe(true);
    await expireLease(state);
    const before = oauthExchanges();
    expect(await setupAs(state, id, undefined, undefined, code)).toBe("bound");
    pause.release();
    await expect(original.outcome).rejects.toMatchObject({
      code: "GITHUB_INSTALL_STATE_REPLAYED",
    });
    expect(oauthExchanges() - before).toBe(1);
  } finally {
    pause.release();
    await original.outcome.catch(() => undefined);
  }
  expect((await unbind(id)).status).toBe(200);
}, 30_000);

it("lets exactly one of two callbacks take over an expired lease", async () => {
  const id = base + 28;
  installation(id, "acme-takeover", ["octo-owner"]);
  const state = await installState(owner);
  const stranded = await stalledSetup(state, id);
  await expireLease(state);
  const blocker = await pool().connect();
  let outcomes: ReturnType<typeof track> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query(
      "SELECT 1 FROM github_installation_states WHERE nonce=$1 FOR UPDATE",
      [nonceOf(state)],
    );
    const before = oauthExchanges();
    const requests = [crypto.randomUUID(), crypto.randomUUID()];
    // Both carry GitHub's one-use code; only the lease's owner spends it.
    const code = github.issueCode("octo-owner");
    outcomes = track(
      Promise.all(
        requests.map((requestId) => setupAs(state, id, undefined, requestId, code)),
      ),
    );
    // Both wait on the row lock: one behind the holder, one queued behind it.
    await until(
      "both takeovers to wait",
      async () =>
        Number(
          (
            await pool().query<{ n: string }>(
              "SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND application_name = ANY($1)",
              [requests.map((r) => `skillplane request=${r}`)],
            )
          ).rows[0]?.n,
        ) === 2,
      outcomes.settled,
    );
    await blocker.query("COMMIT");
    expect(((await outcomes.outcome) as string[]).sort()).toEqual([
      "GITHUB_INSTALL_STATE_REPLAYED",
      "bound",
    ]);
    expect(oauthExchanges() - before).toBe(1);
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    await outcomes?.outcome.catch(() => undefined);
    stranded.release();
    await stranded.setup.outcome.catch(() => undefined);
  }
  await expect(stranded.setup.outcome).rejects.toMatchObject({
    code: "GITHUB_INSTALL_STATE_INVALID",
  });
  expect((await unbind(id)).status).toBe(200);
}, 30_000);

it("keeps the fence when a cutover strands a lease, which then expires", async () => {
  const id = base + 29;
  const org = installation(id, "acme-cutover", ["octo-owner"]);
  org.memberships.set("octo-member", { state: "active", role: "member" });
  const state = await installState(owner);
  const { control, service } = heldInstallations(
    (url) => url.endsWith(`/app/installations/${String(id)}`),
    true,
  );
  let refused: ReturnType<typeof track> | undefined;
  await epoch(1);
  try {
    control.arm();
    refused = track(
      service.completeSetup({
        ...m(),
        fencingEpoch: 1,
        state,
        installationId: id,
        code: github.issueCode("octo-member"),
      }),
    );
    await control.reached;
    // The workspace moves on (the lease copied to the new active cell) before
    // the callback is refused: the old epoch cannot release it.
    await epoch(2);
    control.release();
    await expect(refused.outcome).rejects.toMatchObject({
      code: "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
    });
    expect(await leased(state)).toBe(true);
    const fence = await pool().query<{ active_epoch: string }>(
      "SELECT active_epoch FROM regional_workspace_migration_fences WHERE workspace_id=$1",
      [owner.workspaceId],
    );
    expect(Number(fence.rows[0]?.active_epoch)).toBe(2);
    // The active cell holds the state while the lease lives, then binds it.
    const before = github.requests.length;
    expect(await setupAs(state, id, 2)).toBe("GITHUB_INSTALL_STATE_REPLAYED");
    expect(github.requests.slice(before)).toEqual([]);
    await expireLease(state);
    expect(await setupAs(state, id, 2)).toBe("bound");
  } finally {
    control.release();
    await refused?.outcome.catch(() => undefined);
    await epoch(1);
  }
  expect((await unbind(id)).status).toBe(200);
}, 30_000);

it("needs the organization Members permission to confirm an organization admin", async () => {
  const id = base + 26;
  const org = github.addInstallation({
    id,
    account: { login: "acme-no-members", type: "Organization" },
    repositorySelection: "all",
    repositories: [],
    users: ["octo-owner"],
    permissions: { metadata: "read" },
  });
  const state = await installState(owner);
  // In a workspace migrated into this cell, a refusal releases its
  // lease at the routed epoch, so the same state binds later.
  const setup = () =>
    setupService().completeSetup({
      ...m(),
      fencingEpoch: 2,
      state,
      installationId: id,
      code: github.issueCode("octo-owner"),
    });
  // Only a bind prunes old used nonces; a refusal changes nothing.
  const old = `test-pruned-nonce-${String(base)}`;
  const kept = async () =>
    (
      await pool().query("SELECT 1 FROM github_installation_states WHERE nonce=$1", [
        old,
      ])
    ).rowCount;
  await pool().query(
    "INSERT INTO github_installation_states(nonce,workspace_id,expires_at) VALUES($1,$2,now()-interval '2 days')",
    [old, owner.workspaceId],
  );
  await epoch(2);
  try {
    const before = github.requests.length;
    await expect(setup()).rejects.toMatchObject({
      code: "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
      message: expect.stringContaining("Members: read") as unknown,
    });
    expect(github.requests.slice(before)).not.toContain(
      "GET /api/user/memberships/orgs/acme-no-members",
    );
    expect(await nonceRows(state)).toBe(0);
    expect(await kept()).toBe(1);
    // Once the organization grants it, the same state binds.
    org.permissions = { metadata: "read", members: "read" };
    expect(await setup()).toMatchObject({ installationId: id });
    expect(await kept()).toBe(0);
  } finally {
    await epoch(1);
  }
  expect(await status(id)).toBe("active");
  expect((await unbind(id)).status).toBe(200);
});

it("tells a missing Members grant from a failed admin check in the redirect", async () => {
  const id = base + 31;
  const org = github.addInstallation({
    id,
    account: { login: "acme-reason", type: "Organization" },
    repositorySelection: "all",
    repositories: [],
    users: ["octo-owner"],
    permissions: { metadata: "read" },
  });
  org.memberships.set("octo-member", { state: "active", role: "member" });
  const state = await installState(owner);
  const outcome = async (user: string, installationId = id) => {
    const params = new URLSearchParams({
      installation_id: String(installationId),
      setup_action: "install",
      code: github.issueCode(user),
      state,
    });
    const response = await app.request(`/github/setup?${params.toString()}`, {
      headers: { authorization: `Bearer ${owner.sessionToken}` },
    });
    const location = new URL(
      response.headers.get("location") ?? "",
      "http://localhost",
    );
    return ["github_error", "github_error_reason"].map((key) =>
      location.searchParams.get(key),
    );
  };
  expect(await outcome("octo-owner")).toEqual([
    "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
    "members_permission_required",
  ]);
  // A grant is missing only when well-formed permissions omit or deny it;
  // missing or malformed permissions establish nothing.
  for (const [permissions, reason] of [
    [{ metadata: "read", members: "none" }, "members_permission_required"],
    [undefined, null],
    ["read", null],
    [{ metadata: "read", members: 7 }, null],
    [{ metadata: 1, members: "read" }, null],
    [{ metadata: "" }, null],
    [{ metadata: "unrecognized" }, null],
    [{ metadata: " ", members: "none" }, null],
    [{ metadata: "read", members: "maybe" }, null],
  ] as const) {
    org.permissions = permissions as never;
    expect(await outcome("octo-owner"), JSON.stringify(permissions)).toEqual([
      "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
      reason,
    ]);
  }
  org.permissions = { metadata: "read", members: "read" };
  expect(await outcome("octo-member")).toEqual([
    "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
    "not_admin",
  ]);
  // A definitive membership answer that is not an active admin.
  const membershipOf = "GET /user/memberships/orgs/acme-reason";
  for (const answer of [
    { status: 404 },
    {
      status: 200,
      body: { state: "pending", role: "admin", organization: { login: "acme-reason" } },
    },
    {
      status: 200,
      body: {
        state: "active",
        role: "billing_manager",
        organization: { login: "ACME-reason" },
      },
    },
  ]) {
    github.failures.set(membershipOf, answer);
    expect(await outcome("octo-owner"), JSON.stringify(answer)).toEqual([
      "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
      "not_admin",
    ]);
  }
  github.failures.clear();
  // A check GitHub cannot answer, or answers without the facts it needs, is
  // refused without claiming either reason.
  const membership = "GET /user/memberships/orgs/acme-reason";
  for (const failure of [
    { status: 500 },
    { status: 200, body: { state: "active", role: "admin" } },
    {
      status: 200,
      body: { state: "ACTIVE", role: "ADMIN", organization: { login: "acme-reason" } },
    },
    { status: 200, body: [] },
    // Unknown role, missing or foreign organization, each beside a decisive fact.
    {
      status: 200,
      body: {
        state: "pending",
        role: "unknown",
        organization: { login: "acme-reason" },
      },
    },
    { status: 200, body: { state: "active", role: "member" } },
    {
      status: 200,
      body: { state: "active", role: "member", organization: { login: "acme-other" } },
    },
    {
      status: 200,
      body: { state: "active", role: "admin", organization: { login: "" } },
    },
  ]) {
    github.failures.set(membership, failure);
    expect(await outcome("octo-owner"), JSON.stringify(failure)).toEqual([
      "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
      null,
    ]);
  }
  github.failures.clear();
  const personal = base + 34;
  github.addInstallation({
    id: personal,
    account: { login: "octo-owner", type: "User" },
    repositorySelection: "all",
    repositories: [],
    users: ["octo-owner"],
  });
  for (const [body, reason] of [
    [{}, null],
    [{ login: "" }, null],
    [{ login: " " }, null],
    [{ login: "octo owner" }, null],
    [{ login: "octo/owner" }, null],
    [{ login: 7 }, null],
    [{ login: "octo-other" }, "not_admin"],
  ] as const) {
    github.failures.set("GET /user", { status: 200, body });
    expect(await outcome("octo-owner", personal), JSON.stringify(body)).toEqual([
      "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
      reason,
    ]);
  }
  github.failures.clear();
  // An account type that cannot be bound is no answer about the user either.
  const enterprise = base + 37;
  github.addInstallation({
    id: enterprise,
    account: { login: "acme-enterprise", type: "Enterprise" as "Organization" },
    repositorySelection: "all",
    repositories: [],
    users: ["octo-owner"],
  });
  expect(await outcome("octo-owner", enterprise)).toEqual([
    "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
    null,
  ]);
  // No refusal used the state or bound anything; an admin binds with it.
  expect(await nonceRows(state)).toBe(0);
  expect(await status(id)).toBeUndefined();
  expect(await status(personal)).toBeUndefined();
  expect(await outcome("octo-owner")).toEqual([null, null]);
  expect((await unbind(id)).status).toBe(200);
});

it("follows GitHub's next link and refuses a list it cannot finish", async () => {
  const id = base + 32;
  installation(id, "acme-links", ["octo-owner"]);
  await bind(id);
  // Each page read: [repositories, next link target, total_count].
  let pages: Record<string, [number, string | null, number | undefined]> = {};
  const asked: string[] = [];
  const at = (page: number, host = github.apiBaseUrl) =>
    `${host}/installation/repositories?per_page=100&page=${String(page)}`;
  const listing = new GitHubInstallationService(pool(), {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/installation/repositories"))
        return fetch(input, init);
      const page = url.searchParams.get("page") ?? "";
      asked.push(page);
      const [count, next, total] = pages[page] ?? [0, null, 0];
      return Response.json(
        {
          total_count: total,
          repositories: Array.from({ length: count }, (_, i) => ({
            full_name: `acme-links/p${page}-${String(i)}`,
            private: true,
            default_branch: "main",
          })),
        },
        // A target becomes a rel="next" link; a value starting "<" is the header.
        {
          headers: next
            ? { link: next.startsWith("<") ? next : `<${next}>; rel="next"` }
            : {},
        },
      );
    },
  });
  const read = async (cursor: string | null = null) => {
    asked.length = 0;
    return listing.repositories(ownerPrincipal(), id, cursor);
  };
  // GitHub's target is read, even past an empty page, and the latest count
  // holds until a newer one supersedes it: 999 left unmet is a retry.
  pages = { 1: [100, at(3), 999], 3: [0, at(7), 999], 7: [40, null, undefined] };
  await expect(read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(asked).toEqual(["1", "3", "7"]);
  pages = { 1: [100, at(3), 140], 3: [0, at(7), undefined], 7: [40, null, undefined] };
  expect(await read()).toMatchObject({ truncated: false, nextCursor: null });
  expect(asked).toEqual(["1", "3", "7"]);
  pages = { 1: [100, at(2), 999], 2: [40, null, 140] };
  expect(await read()).toMatchObject({ truncated: false, nextCursor: null });
  // A count that is supplied but malformed establishes nothing: a retry.
  for (const total of [140.5, "40", null, -1])
    for (const first of [
      [40, null, total],
      [100, at(2), total],
    ] as const) {
      pages = { 1: first as never, 2: [40, null, 140] };
      await expect(read(), JSON.stringify(first)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
    }
  // A token or quoted relation list, and next links that agree, are followed.
  for (const link of [
    `<${at(2)}>; rel=next`,
    `<${at(2)}>; REL="prev next"`,
    `<${at(2)}>; rel="next", <${at(2)}>; rel=next`,
    `<${at(2)}>; rel="next https://relations.example.invalid/page?version=1"`,
  ]) {
    pages = { 1: [100, link, 140], 2: [40, null, undefined] };
    expect(await read(), link).toMatchObject({ truncated: false, nextCursor: null });
    expect(asked).toEqual(["1", "2"]);
  }
  // The cursor past a batch is the page GitHub's link names.
  pages = Object.fromEntries([1, 2, 3, 4, 5].map((p) => [p, [100, at(p + 1), 501]]));
  pages[6] = [1, null, 501];
  const batch = await read();
  expect(batch.repositories).toHaveLength(500);
  expect(batch).toMatchObject({ truncated: true, nextCursor: "6" });
  expect(await read("6")).toMatchObject({ truncated: false, nextCursor: null });
  expect(asked).toEqual(["6"]);
  // A continuation must itself establish the end: no count and no link is a retry.
  pages[6] = [40, null, undefined];
  await expect(read("6")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  // A cursor carries only a page: one the pages read cannot account for, after
  // a short page or a jump, is a retry rather than a gap in the list.
  for (const [short, last] of [
    [30, 6],
    [100, 9],
  ]) {
    pages = Object.fromEntries(
      [1, 2, 3, 4, 5].map((p) => [
        p,
        [p === 1 ? short : 100, at(p === 5 ? last : p + 1), 530],
      ]),
    );
    await expect(read(), `${String(short)} to ${String(last)}`).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  }
  pages = Object.fromEntries([1, 2, 3, 4, 5].map((p) => [p, [100, at(p + 1), 501]]));
  // Exactly five full pages end the list when GitHub's count agrees.
  pages[5] = [100, null, 500];
  expect(await read()).toMatchObject({ truncated: false, nextCursor: null });
  // More said to remain with no next link is a retry, never a short list, and
  // so is a next link this listing cannot follow, even on a short last page.
  const unusable: [string | null, number, number][] = [
    [null, 100, 250],
    [at(2, "http://example.invalid/api"), 40, 40],
    [`${at(2)}&page=3`, 40, 40],
    [at(2).replace("page=2", "page=x"), 40, 40],
    [at(10000), 40, 40],
    [at(2).replace("per_page=100", "per_page=50"), 40, 40],
    [`${at(2)}&q=x`, 40, 40],
    [at(1), 40, 40],
    // Two next links that disagree.
    [`${at(3)}>; rel="next", <${at(2)}`, 40, 40],
    // A malformed relation, or an unusable target beside a valid one.
    [`<${at(2)}>; rel=next=x`, 40, 40],
    [`<${at(2)}>; rel="next"x`, 40, 40],
    [`<${at(2)}>; rel`, 40, 40],
    [`<${at(2)}>; rel="next = junk"`, 40, 40],
    [`<${at(2)}>; rel="next=x"`, 40, 40],
    [`<${at(2)}>; rel=next, <${at(2, "http://example.invalid/api")}; rel=next`, 40, 40],
    [`<${at(2)}>; rel="next, <${at(2)}>; rel=next`, 40, 40],
    [
      `<${at(2)}>; rel="next", <${at(2, "http://example.invalid/api")}>; rel="next"`,
      40,
      40,
    ],
    [`<${at(2)}>; rel="next", ${at(2)}; rel="next"`, 40, 40],
  ];
  for (const [next, count, total] of unusable) {
    pages = { 1: [count, next, total] };
    await expect(read(), String(next)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    expect(asked).toEqual(["1"]);
  }
  // A short earlier page counts for what it held, not for a full page.
  pages = { 1: [30, at(2), 110], 2: [10, null, 110] };
  await expect(read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  // A link back to an earlier page never loops the listing.
  pages = { 1: [100, at(3), 999], 3: [100, at(1), 999] };
  await expect(read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(asked).toEqual(["1", "3"]);
  pages = { 1: [100, null, undefined] };
  await expect(read()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect((await unbind(id)).status).toBe(200);
});

it("orders a bind's observation by its App request, not by its claim", async () => {
  const id = base + 17;
  const fake = installation(id, "acme-setup-order", ["octo-owner"]);
  await bind(id);
  const { sources } = heldSources();
  const source = await sources.create({
    ...m(),
    idempotencyKey: crypto.randomUUID(),
    config: {
      repositoryUrl: "https://github.com/acme-setup-order/private-skills",
      ref: "main",
      installationId: id,
    },
  });
  const revision = async () =>
    (
      await services.database.pool.query<{ revision: number }>(
        "SELECT revision FROM skill_sources WHERE id=$1",
        [source.id],
      )
    ).rows[0]?.revision;
  // An App whose next JWT signing waits until released: setup pauses after
  // its claim and OAuth, before it asks GitHub for the installation.
  const app = services.githubApp;
  if (!app) throw new Error("GitHub App is not configured");
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  let gate: Promise<void> | null = new Promise<void>((resolve) => (release = resolve));
  const slowApp = new Proxy(app, {
    get(target, key) {
      if (key === "appJwt")
        return async () => {
          const held = gate;
          gate = null;
          if (held) {
            entered();
            await held;
          }
          return target.appJwt();
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  const binding = new GitHubInstallationService(services.database.pool, {
    app: slowApp,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
  }).completeSetup({
    ...m(),
    state: await installState(owner),
    installationId: id,
    code: github.issueCode("octo-owner"),
  });
  await reached;
  // A refresh while setup signs records active; GitHub then suspends it.
  expect(await status(id)).toBe("active");
  fake.suspendedAt = new Date().toISOString();
  const before = await revision();
  release();
  expect((await binding).status).toBe("suspended");
  expect(await revision()).toBe((before ?? 0) + 1);
  fake.suspendedAt = null;
  expect(await status(id)).toBe("active");
});

it("never lets a failed preview supersede a newer successful one", async () => {
  const id = base + 18;
  installation(id, "acme-stale-failure", ["octo-owner"]);
  await bind(id);
  const { control, sources } = heldSources();
  const source = await sources.create({
    ...m(),
    idempotencyKey: crypto.randomUUID(),
    config: {
      repositoryUrl: "https://github.com/acme-stale-failure/private-skills",
      ref: "main",
      installationId: id,
    },
  });
  const authStatus = async () =>
    (await sources.get(ownerPrincipal(), source.id)).source.authStatus;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
  control.hold(true);
  const failing = sources.preview({ ...m(), sourceId: source.id });
  failing.catch(() => undefined);
  await control.reached;
  control.held = null;
  // The newer success saves while the stale failure records its marker: both
  // wait on a lock the test holds, so neither commits before the other runs.
  const lock = await services.database.pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT 1 FROM skill_sources WHERE id=$1 FOR UPDATE", [source.id]);
    const succeeding = sources.preview({ ...m(), sourceId: source.id });
    await pause();
    control.release();
    await pause();
    await lock.query("COMMIT");
    await succeeding;
  } finally {
    lock.release();
  }
  await expect(failing).rejects.toMatchObject({ code: "GIT_SOURCE_AUTH_FAILED" });
  expect(await authStatus()).toBe("ok");
  // A failure that asked GitHub after that success governs.
  control.hold(true);
  const later = sources.preview({ ...m(), sourceId: source.id });
  await control.reached;
  control.release();
  await expect(later).rejects.toMatchObject({ code: "GIT_SOURCE_AUTH_FAILED" });
  expect(await authStatus()).toBe("auth_failed");
});

it("refuses an unfinished private-source apply while its installation is inactive", async () => {
  const id = base + 19;
  const fake = installation(id, "acme-inactive-apply", ["octo-owner"]);
  await bind(id);
  const { control, sources } = heldSources();
  const source = await sources.create({
    ...m(),
    idempotencyKey: crypto.randomUUID(),
    config: {
      repositoryUrl: "https://github.com/acme-inactive-apply/private-skills",
      ref: "main",
      installationId: id,
    },
  });
  const done = await sources.preview({ ...m(), sourceId: source.id });
  await sources.apply({ ...m(), sourceId: source.id, runId: done.id });
  let pending = await sources.preview({ ...m(), sourceId: source.id });
  const lease = async () =>
    (
      await services.database.pool.query(
        "SELECT revision,sync_token FROM skill_sources WHERE id=$1",
        [source.id],
      )
    ).rows[0] as unknown;
  const deactivations: [() => Promise<unknown>, () => Promise<unknown>][] = [
    [() => unbind(id), () => bind(id)],
    [
      async () => {
        fake.suspendedAt = new Date().toISOString();
        expect(await status(id)).toBe("suspended");
      },
      async () => {
        fake.suspendedAt = null;
        expect(await status(id)).toBe("active");
      },
    ],
  ];
  for (const [deactivate, reconnect] of deactivations) {
    await deactivate();
    const [held, snapshots] = [await lease(), control.snapshots.length];
    await expect(
      sources.apply({ ...m(), sourceId: source.id, runId: pending.id }),
    ).rejects.toMatchObject({ code: "GIT_SOURCE_AUTH_FAILED" });
    expect(await lease()).toEqual(held);
    expect(control.snapshots).toHaveLength(snapshots);
    // A completed run still replays, and reconnecting needs a fresh preview.
    expect(
      await sources.apply({ ...m(), sourceId: source.id, runId: done.id }),
    ).toMatchObject({ id: done.id, status: "complete" });
    await reconnect();
    await expect(
      sources.apply({ ...m(), sourceId: source.id, runId: pending.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    pending = await sources.preview({ ...m(), sourceId: source.id });
  }
});

it("withholds a repository listing whose binding changed while it was read", async () => {
  const id = base + 20;
  const fake = installation(id, "acme-discovery", ["octo-owner"]);
  await bind(id);
  const { control, service } = heldInstallations((url) =>
    url.includes("/installation/repositories"),
  );
  const changes = [
    () => unbind(id),
    async () => {
      expect((await unbind(id)).status).toBe(200);
      await bind(id);
    },
    async () => {
      fake.suspendedAt = new Date().toISOString();
      expect(await status(id)).toBe("suspended");
    },
    // Suspended and resumed before the listing finishes.
    async () => {
      fake.suspendedAt = new Date().toISOString();
      expect(await status(id)).toBe("suspended");
      fake.suspendedAt = null;
      expect(await status(id)).toBe("active");
    },
  ];
  for (const change of changes) {
    control.arm();
    const listing = service.repositories(ownerPrincipal(), id);
    listing.catch(() => undefined);
    await control.reached;
    await change();
    control.release();
    await expect(listing).rejects.toMatchObject({ code: "GIT_SOURCE_AUTH_FAILED" });
    fake.suspendedAt = null;
    if ((await status(id)) === undefined) await bind(id);
    expect(await status(id)).toBe("active");
  }
  // Refreshes that change nothing do not withhold a listing.
  control.arm();
  const steady = service.repositories(ownerPrincipal(), id);
  await control.reached;
  expect(await status(id)).toBe("active");
  control.release();
  expect((await steady).repositories).toHaveLength(1);
});

it("bounds GitHub responses and classifies refused discovery", async () => {
  const id = base + 21;
  const fake = installation(id, "acme-bounds", ["octo-owner"]);
  await bind(id);
  // A token response larger than the general cap still lists repositories.
  const large = new GitHubInstallationService(services.database.pool, {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    fetcher: async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).endsWith("/access_tokens")) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return Response.json(
        { ...body, padding: "x".repeat(2 * 1024 * 1024) },
        { status: response.status },
      );
    },
  });
  expect((await large.repositories(ownerPrincipal(), id)).repositories).toHaveLength(1);
  // A contradictory total_count never ends a listing after a full page; any
  // valid form of GitHub's next link on the API host continues it.
  let relink = (link: string) => link;
  const miscounted = new GitHubInstallationService(services.database.pool, {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    fetcher: async (input, init) => {
      const response = await fetch(input, init);
      if (!String(input).includes("/installation/repositories")) return response;
      const body = (await response.json()) as Record<string, unknown>;
      const link = response.headers.get("link");
      return Response.json(
        { ...body, total_count: 0 },
        { status: response.status, headers: link ? { link: relink(link) } : {} },
      );
    },
  });
  const granted = fake.repositories;
  fake.repositories = Array.from({ length: 150 }, (_, i) => ({
    fullName: `acme-bounds/skills-${String(i)}`,
    private: true,
    defaultBranch: "main",
  }));
  for (const [form, length] of [
    [(link: string) => link, 150],
    [(link: string) => link.replace('rel="next"', "rel=next"), 150],
    [(link: string) => link.replace('rel="next"', 'rel="next last"'), 150],
    [(link: string) => link.replace(/<[^>]*\/(repositories\?[^>]*)>/u, "<$1>"), 150],
    [(link: string) => link.replace("; rel", '; title="more, see; this"; rel'), 150],
    [(link: string) => link.replace(">;", "#a;b>;"), 150],
  ] as const) {
    relink = form;
    const counted = await miscounted.repositories(ownerPrincipal(), id);
    expect(counted.repositories).toHaveLength(length);
    expect(counted).toMatchObject({ truncated: false, nextCursor: null });
  }
  // A next link to another host is not followed, so the full page is no end.
  relink = (link: string) => link.replace("127.0.0.1", "localhost");
  await expect(miscounted.repositories(ownerPrincipal(), id)).rejects.toMatchObject({
    code: "SERVICE_UNAVAILABLE",
  });
  fake.repositories = granted;
  // An endless body is refused whether its length is missing or wrong, and
  // the listing keeps the last observation.
  fake.suspendedAt = new Date().toISOString();
  expect(await status(id)).toBe("suspended");
  fake.suspendedAt = null;
  for (const headers of [{}, { "content-length": "10" }]) {
    const endless = new GitHubInstallationService(services.database.pool, {
      app: services.githubApp ?? null,
      settings: services.githubInstallSettings ?? null,
      stateSecret: services.tenancySecret,
      fetcher: async (input, init) =>
        String(input).endsWith(`/app/installations/${String(id)}`)
          ? new Response(
              new ReadableStream({
                pull: (controller) =>
                  controller.enqueue(new Uint8Array(65536).fill(32)),
              }),
              { status: 200, headers },
            )
          : fetch(input, init),
    });
    expect((await endless.list(m())).find((i) => i.installationId === id)?.status).toBe(
      "suspended",
    );
  }
  // An unreadable suspension keeps the last state and binds nothing; an
  // explicit null is a resumption.
  github.failures.set(`GET /app/installations/${String(id)}`, {
    status: 200,
    body: {
      id,
      account: { login: "acme-bounds", type: "Organization" },
      repository_selection: "selected",
      suspended_at: "not-a-date",
    },
  });
  expect(await status(id)).toBe("suspended");
  github.failures.set(`GET /app/installations/${String(id)}`, {
    status: 200,
    body: {
      id,
      account: { login: "acme-bounds", type: "Organization" },
      repository_selection: "selected",
    },
  });
  expect(await status(id)).toBe("suspended");
  expect(
    (
      await callback(owner, {
        state: await installState(owner),
        installationId: id,
        code: github.issueCode("octo-owner"),
      })
    ).error,
  ).toBe("SERVICE_UNAVAILABLE");
  github.failures.clear();
  expect(await status(id)).toBe("active");
  // Nor does a timestamp only a lenient parser reads suspend it.
  for (const suspendedAt of ["0", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z"]) {
    github.failures.set(`GET /app/installations/${String(id)}`, {
      status: 200,
      body: {
        id,
        account: { login: "acme-bounds", type: "Organization" },
        repository_selection: "selected",
        suspended_at: suspendedAt,
      },
    });
    expect(await status(id), suspendedAt).toBe("active");
  }
  github.failures.clear();
  // Refused installation access is auth_failed; throttling and the App's own
  // credentials are retryable service failures.
  for (const [key, failure, code] of [
    ["GET /installation/repositories", { status: 401 }, "GIT_SOURCE_AUTH_FAILED"],
    ["GET /installation/repositories", { status: 403 }, "GIT_SOURCE_AUTH_FAILED"],
    ["GET /installation/repositories", { status: 404 }, "GIT_SOURCE_AUTH_FAILED"],
    [
      "GET /installation/repositories",
      { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      "SERVICE_UNAVAILABLE",
    ],
    [
      `POST /app/installations/${String(id)}/access_tokens`,
      { status: 401 },
      "SERVICE_UNAVAILABLE",
    ],
  ] as const) {
    github.failures.set(key, failure);
    expect(
      await errorCode(await repositoriesOf(id)),
      `${key} ${String(failure.status)}`,
    ).toBe(code);
    github.failures.clear();
  }
});

it("lists the stored state when no GitHub check is usable", async () => {
  const id = base + 22;
  installation(id, "acme-all-failed", ["octo-owner"]);
  await bind(id);
  // Every installation check fails; the first one waits until released.
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => (entered = resolve));
  let gate: Promise<void> | null = new Promise<void>((resolve) => (release = resolve));
  const failing = new GitHubInstallationService(services.database.pool, {
    app: services.githubApp ?? null,
    settings: services.githubInstallSettings ?? null,
    stateSecret: services.tenancySecret,
    fetcher: async (input, init) => {
      if (!/\/app\/installations\/[0-9]+$/u.test(String(input)))
        return fetch(input, init);
      const held = gate;
      gate = null;
      if (held) {
        entered();
        await held;
      }
      return Response.json({ message: "unavailable" }, { status: 500 });
    },
  });
  const listing = failing.list(m());
  await reached;
  expect((await unbind(id)).status).toBe(200);
  release();
  expect((await listing).map((i) => i.installationId)).not.toContain(id);
});

it("ranks an apply's outcome by when it asked GitHub", async () => {
  const id = base + 23;
  installation(id, "acme-apply-order", ["octo-owner"]);
  await bind(id);
  const { control, sources } = heldSources();
  const source = await sources.create({
    ...m(),
    idempotencyKey: crypto.randomUUID(),
    config: {
      repositoryUrl: "https://github.com/acme-apply-order/private-skills",
      ref: "main",
      installationId: id,
    },
  });
  const run = await sources.preview({ ...m(), sourceId: source.id });
  // The apply asks GitHub and fails; a preview asks later and succeeds, but
  // the apply records its failure first.
  control.hold(true);
  const applying = sources.apply({ ...m(), sourceId: source.id, runId: run.id });
  applying.catch(() => undefined);
  await control.reached;
  const releaseApply = control.release;
  control.hold();
  const previewing = sources.preview({ ...m(), sourceId: source.id });
  await control.reached;
  releaseApply();
  await expect(applying).rejects.toMatchObject({ code: "GIT_SOURCE_AUTH_FAILED" });
  control.release();
  await previewing;
  expect((await sources.get(ownerPrincipal(), source.id)).source.authStatus).toBe("ok");
});
