import type { Pool, PoolClient } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import type { Principal } from "./principal.js";
import { withDomainTransaction } from "./transactions.js";
import { insertPrincipalAudit } from "./mutation-audit.js";
import {
  GITHUB_API_VERSION,
  GitHubAuthFailedError,
  discardBody,
  isGitHubRateLimited,
  type GitHubApp,
} from "./github-app.js";

/** An install `state` is accepted for this long after it is issued. */
export const GITHUB_INSTALL_STATE_TTL_MS = 10 * 60 * 1000;
const USER_AGENT = "Skillplane-github-app";
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_INSTALLATIONS = 20;
const MAX_REPOSITORY_PAGES = 5;
const MAX_USER_INSTALLATION_PAGES = 10;
const STATE_PURPOSE = "github-install-state";
const NONCE = /^[A-Za-z0-9_-]{22,64}$/u;
const INSTALLATION_ID = /^[1-9][0-9]{0,15}$/u;
const OAUTH_CODE = /^[A-Za-z0-9_.-]{1,256}$/u;
const TOKEN = /^[A-Za-z0-9_.-]{20,32768}$/u;
const encoder = new TextEncoder();

/** Where Skillplane sends the installing user and how it verifies them. */
export interface GitHubInstallSettings {
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;
}

export interface GitHubInstallationServiceOptions {
  /** Acts as the App; null when the App secrets are not configured. */
  readonly app: GitHubApp | null;
  readonly settings: GitHubInstallSettings | null;
  /** Signs install states; the same value must reach every API instance. */
  readonly stateSecret: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

export type GitHubInstallationStatus = "active" | "suspended" | "removed";

export interface GitHubInstallation {
  readonly installationId: number;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositorySelection: "all" | "selected";
  readonly status: GitHubInstallationStatus;
  readonly suspendedAt: string | null;
  readonly removedAt: string | null;
  readonly checkedAt: string;
  readonly createdAt: string;
}

export interface GitHubInstallationRepository {
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string | null;
  readonly url: string;
}

interface InstallationRow {
  installation_id: string;
  workspace_id: string;
  account_login: string;
  account_type: string;
  repository_selection: "all" | "selected";
  suspended_at: Date | null;
  removed_at: Date | null;
  checked_at: Date;
  created_at: Date;
}

interface StateClaims {
  readonly v: 1;
  readonly w: string;
  readonly u: string;
  readonly n: string;
  readonly e: number;
}

interface ObservedInstallation {
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositorySelection: "all" | "selected";
  readonly suspendedAt: string | null;
}

interface Mutation {
  readonly principal: Principal;
  readonly requestId: string;
  readonly fencingEpoch?: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  try {
    const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeClaims(payload: string): StateClaims | null {
  const bytes = fromBase64Url(payload);
  if (!bytes || bytes.length > 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const claims = value as Partial<StateClaims>;
  return claims.v === 1 &&
    typeof claims.w === "string" &&
    claims.w.length > 0 &&
    claims.w.length <= 200 &&
    typeof claims.u === "string" &&
    claims.u.length > 0 &&
    claims.u.length <= 200 &&
    typeof claims.n === "string" &&
    NONCE.test(claims.n) &&
    typeof claims.e === "number" &&
    Number.isSafeInteger(claims.e)
    ? (claims as StateClaims)
    : null;
}

/**
 * The workspace an install `state` names, read without verifying it, so a
 * gateway can route the callback to the workspace's cell. The cell verifies
 * the signature, expiry, user and single use before acting on it.
 */
export function githubInstallStateWorkspace(state: string | null): string | null {
  if (!state || state.length > 2048) return null;
  const [payload = ""] = state.split(".");
  return decodeClaims(payload)?.w ?? null;
}

function invalidState(
  message = "The GitHub install link is invalid or expired; start again",
): never {
  throw new DomainError("GITHUB_INSTALL_STATE_INVALID", message, 400);
}

function unavailable(message = "GitHub could not be reached; retry later"): never {
  throw new DomainError("SERVICE_UNAVAILABLE", message, 503);
}

function record(row: InstallationRow): GitHubInstallation {
  return {
    installationId: Number(row.installation_id),
    accountLogin: row.account_login,
    accountType: row.account_type,
    repositorySelection: row.repository_selection,
    status: row.removed_at ? "removed" : row.suspended_at ? "suspended" : "active",
    suspendedAt: row.suspended_at?.toISOString() ?? null,
    removedAt: row.removed_at?.toISOString() ?? null,
    checkedAt: row.checked_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function parseInstallationId(value: unknown): number {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !INSTALLATION_ID.test(text))
    throw new DomainError("VALIDATION_FAILED", "Invalid GitHub App installation", 400, {
      field: "installationId",
    });
  const id = Number(text);
  if (!Number.isSafeInteger(id))
    throw new DomainError("VALIDATION_FAILED", "Invalid GitHub App installation", 400, {
      field: "installationId",
    });
  return id;
}

async function readJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) {
    await discardBody(response);
    unavailable("GitHub returned an oversized response");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    unavailable();
  }
  if (text.length > MAX_RESPONSE_BYTES)
    unavailable("GitHub returned an oversized response");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    unavailable("GitHub returned an invalid response");
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function observedInstallation(value: unknown): ObservedInstallation | null {
  const body = object(value);
  const account = object(body?.account);
  const login = account?.login ?? account?.slug;
  const type =
    typeof account?.type === "string"
      ? account.type
      : account?.slug
        ? "Enterprise"
        : null;
  const selection = body?.repository_selection;
  const suspended = body?.suspended_at;
  if (
    typeof login !== "string" ||
    login.length < 1 ||
    login.length > 100 ||
    (type !== "User" && type !== "Organization" && type !== "Enterprise") ||
    (selection !== "all" && selection !== "selected") ||
    (suspended !== null && suspended !== undefined && typeof suspended !== "string")
  )
    return null;
  const suspendedAt =
    typeof suspended === "string" && !Number.isNaN(Date.parse(suspended))
      ? new Date(suspended).toISOString()
      : null;
  return {
    accountLogin: login,
    accountType: type,
    repositorySelection: selection,
    suspendedAt,
  };
}

/**
 * Binds Skillplane GitHub App installations to workspaces. The install
 * callback trusts only its signed, single-use `state`: the installing user
 * must prove (with GitHub's user authorization code) that they can access the
 * installation, and the installation is then fetched with the App JWT.
 */
export class GitHubInstallationService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  readonly #options: GitHubInstallationServiceOptions;
  #stateKey: Promise<CryptoKey> | null = null;

  constructor(
    private readonly pool: Pool,
    options: GitHubInstallationServiceOptions,
  ) {
    this.#options = options;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether installing from settings is configured in this deployment. */
  get installable(): boolean {
    return this.#options.app !== null && this.#options.settings !== null;
  }

  private configured(): { app: GitHubApp; settings: GitHubInstallSettings } {
    const { app, settings } = this.#options;
    if (!app || !settings)
      throw new DomainError(
        "GITHUB_APP_NOT_CONFIGURED",
        "The GitHub App is not configured for this deployment",
        503,
      );
    return { app, settings };
  }

  private stateKey(): Promise<CryptoKey> {
    this.#stateKey ??= crypto.subtle
      .digest(
        "SHA-256",
        encoder.encode(`${STATE_PURPOSE}\u0000${this.#options.stateSecret}`),
      )
      .then((material) =>
        crypto.subtle.importKey(
          "raw",
          material,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      );
    return this.#stateKey;
  }

  /**
   * The GitHub App install URL for an owner or admin, carrying a signed
   * state bound to the workspace and user that expires in ten minutes.
   */
  async installUrl(principal: Principal): Promise<string> {
    authorize(principal, "workspace:update");
    if (principal.kind !== "user")
      throw new DomainError(
        "FORBIDDEN",
        "Only a signed-in user can install the GitHub App",
        403,
      );
    const { settings } = this.configured();
    const claims: StateClaims = {
      v: 1,
      w: principal.workspaceId,
      u: principal.userId,
      n: base64Url(crypto.getRandomValues(new Uint8Array(24))),
      e: this.now() + GITHUB_INSTALL_STATE_TTL_MS,
    };
    const payload = base64Url(encoder.encode(JSON.stringify(claims)));
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", await this.stateKey(), encoder.encode(payload)),
    );
    const url = new URL(
      `${settings.webBaseUrl}/apps/${encodeURIComponent(settings.slug)}/installations/new`,
    );
    url.searchParams.set("state", `${payload}.${base64Url(signature)}`);
    return url.toString();
  }

  /**
   * Verifies an install state's signature and expiry and returns the
   * workspace it was issued for. It does not consume the state.
   */
  async verifyInstallState(state: unknown): Promise<{ workspaceId: string }> {
    return { workspaceId: (await this.verifyState(state)).w };
  }

  private async verifyState(state: unknown): Promise<StateClaims> {
    if (typeof state !== "string" || state.length > 2048) invalidState();
    const parts = state.split(".");
    const [payload = "", signature = ""] = parts;
    const claims = parts.length === 2 ? decodeClaims(payload) : null;
    const mac = fromBase64Url(signature);
    if (!claims || !mac) invalidState();
    const valid = await crypto.subtle.verify(
      "HMAC",
      await this.stateKey(),
      mac,
      encoder.encode(payload),
    );
    if (!valid) invalidState();
    const now = this.now();
    if (claims.e <= now || claims.e > now + GITHUB_INSTALL_STATE_TTL_MS) invalidState();
    return claims;
  }

  private async github(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/vnd.github+json");
    headers.set("x-github-api-version", GITHUB_API_VERSION);
    headers.set("user-agent", USER_AGENT);
    try {
      return await this.fetcher(url, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      unavailable();
    }
  }

  private async appRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const { app } = this.configured();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await app.appJwt()}`);
    return this.github(`${app.apiBaseUrl}${path}`, { ...init, headers });
  }

  /** The installation as GitHub reports it now; null when it was removed. */
  private async fetchInstallation(
    installationId: number,
  ): Promise<ObservedInstallation | null> {
    const response = await this.appRequest(
      `/app/installations/${String(installationId)}`,
    );
    if (response.status === 404) {
      await discardBody(response);
      return null;
    }
    if (response.status !== 200) {
      if (await isGitHubRateLimited(response))
        unavailable("GitHub rate limit reached; retry later");
      await discardBody(response);
      unavailable("GitHub could not return the installation; retry later");
    }
    const observed = observedInstallation(await readJson(response));
    if (!observed) unavailable("GitHub returned an invalid installation");
    return observed;
  }

  /** Exchanges the installing user's authorization code for a user token. */
  private async userToken(
    settings: GitHubInstallSettings,
    code: string,
  ): Promise<string> {
    const response = await this.github(
      `${settings.webBaseUrl}/login/oauth/access_token`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          client_id: settings.clientId,
          client_secret: settings.clientSecret,
          code,
        }),
      },
    );
    if (response.status !== 200) {
      await discardBody(response);
      unavailable("GitHub could not verify the installing user; retry later");
    }
    const token = object(await readJson(response))?.access_token;
    if (typeof token !== "string" || !TOKEN.test(token))
      throw new DomainError(
        "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
        "GitHub did not confirm the installing user; install the App again from settings",
        403,
      );
    return token;
  }

  /** The account login of the installation as the user sees it, if they can. */
  private async userInstallationAccount(
    settings: GitHubInstallSettings,
    token: string,
    installationId: number,
  ): Promise<string | null> {
    for (let page = 1; page <= MAX_USER_INSTALLATION_PAGES; page += 1) {
      const response = await this.github(
        `${settings.apiBaseUrl}/user/installations?per_page=100&page=${String(page)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (response.status === 401 || response.status === 403) {
        if (await isGitHubRateLimited(response))
          unavailable("GitHub rate limit reached; retry later");
        await discardBody(response);
        return null;
      }
      if (response.status !== 200) {
        await discardBody(response);
        unavailable("GitHub could not list the user's installations; retry later");
      }
      const list = object(await readJson(response))?.installations;
      if (!Array.isArray(list))
        unavailable("GitHub returned an invalid installation list");
      for (const entry of list) {
        const item = object(entry);
        if (item?.id === installationId) {
          const account = object(item.account);
          const login = account?.login ?? account?.slug;
          return typeof login === "string" ? login : null;
        }
      }
      if (list.length < 100) return null;
    }
    return null;
  }

  /**
   * Completes the GitHub install redirect. The state must be valid, unexpired,
   * unused and issued to this user for this workspace; the user must still be
   * an owner or admin and must be able to access the installation on GitHub,
   * and the installation's account must match what the App sees. An
   * installation bound to another workspace is refused.
   */
  async completeSetup(
    m: Mutation & { state: unknown; installationId: unknown; code: unknown },
  ): Promise<GitHubInstallation> {
    const claims = await this.verifyState(m.state);
    if (
      m.principal.kind !== "user" ||
      claims.w !== m.principal.workspaceId ||
      claims.u !== m.principal.userId
    )
      invalidState("The GitHub install link was issued to another user or workspace");
    authorize(m.principal, "workspace:update");
    const installationId = parseInstallationId(m.installationId);
    if (typeof m.code !== "string" || !OAUTH_CODE.test(m.code))
      throw new DomainError(
        "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
        "GitHub did not confirm the installing user; enable user authorization during installation and retry",
        403,
      );
    const { settings } = this.configured();
    const consumed = await withDomainTransaction(
      this.pool,
      m.requestId,
      async ({ client }) => {
        await client.query(
          "DELETE FROM github_installation_states WHERE workspace_id=$1 AND expires_at < now()",
          [claims.w],
        );
        return client.query(
          "INSERT INTO github_installation_states(nonce,workspace_id,expires_at) VALUES($1,$2,$3) ON CONFLICT (nonce) DO NOTHING",
          [claims.n, claims.w, new Date(claims.e)],
        );
      },
      { fencingEpoch: m.fencingEpoch },
    );
    if (!consumed.rowCount)
      throw new DomainError(
        "GITHUB_INSTALL_STATE_REPLAYED",
        "The GitHub install link was already used; start again",
        409,
      );
    const token = await this.userToken(settings, m.code);
    const userAccount = await this.userInstallationAccount(
      settings,
      token,
      installationId,
    );
    if (!userAccount)
      throw new DomainError(
        "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
        "You cannot access this GitHub App installation on GitHub",
        403,
      );
    const observed = await this.fetchInstallation(installationId);
    if (observed?.accountLogin.toLowerCase() !== userAccount.toLowerCase())
      throw new DomainError(
        "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
        "GitHub did not confirm this installation; install the App again from settings",
        403,
      );
    return withDomainTransaction(
      this.pool,
      m.requestId,
      async ({ client }) => {
        const bound = await client.query<InstallationRow>(
          `INSERT INTO github_installations
             (installation_id,workspace_id,account_login,account_type,repository_selection,suspended_at,bound_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (installation_id) DO UPDATE SET
             account_login=EXCLUDED.account_login, account_type=EXCLUDED.account_type,
             repository_selection=EXCLUDED.repository_selection, suspended_at=EXCLUDED.suspended_at,
             removed_at=NULL, checked_at=now(), updated_at=now()
           WHERE github_installations.workspace_id=EXCLUDED.workspace_id
           RETURNING *`,
          [
            installationId,
            m.principal.workspaceId,
            observed.accountLogin,
            observed.accountType,
            observed.repositorySelection,
            observed.suspendedAt,
            m.principal.actorId,
          ],
        );
        const row = bound.rows[0];
        if (!row)
          throw new DomainError(
            "GITHUB_INSTALLATION_BOUND_ELSEWHERE",
            "This GitHub App installation is already connected to another workspace",
            409,
          );
        await this.audit(client, m, installationId, "bound", {
          accountLogin: observed.accountLogin,
        });
        return record(row);
      },
      { fencingEpoch: m.fencingEpoch },
    );
  }

  private audit(
    client: PoolClient,
    m: Mutation,
    installationId: number,
    event: "bound" | "unbound",
    metadata: Record<string, unknown> = {},
  ) {
    return insertPrincipalAudit(client, m.principal, {
      eventType: `github_installation.${event}`,
      action: "workspace:update",
      requestId: m.requestId,
      resourceType: "github_installation",
      resourceId: String(installationId),
      metadata: { installationId, ...metadata },
    });
  }

  /**
   * The workspace's installations. When the App is configured, each one is
   * checked on GitHub first, so an installation removed or suspended there
   * shows as such; a check GitHub cannot answer keeps the last observed state.
   */
  async list(m: Mutation): Promise<GitHubInstallation[]> {
    authorize(m.principal, "workspace:read");
    const rows = (
      await this.pool.query<InstallationRow>(
        "SELECT * FROM github_installations WHERE workspace_id=$1 ORDER BY created_at, installation_id LIMIT $2",
        [m.principal.workspaceId, MAX_INSTALLATIONS],
      )
    ).rows;
    if (!this.#options.app || rows.length === 0) return rows.map(record);
    const observed = await Promise.all(
      rows.map((row) =>
        this.fetchInstallation(Number(row.installation_id)).then(
          (value) => ({ row, value, ok: true as const }),
          () => ({ row, value: null, ok: false as const }),
        ),
      ),
    );
    const checked = observed.filter((entry) => entry.ok);
    if (checked.length === 0) return rows.map(record);
    const refreshed = await withDomainTransaction(
      this.pool,
      m.requestId,
      async ({ client }) => {
        const out = new Map<string, InstallationRow>();
        for (const { row, value } of checked) {
          const updated = await client.query<InstallationRow>(
            value
              ? `UPDATE github_installations SET account_login=$3, account_type=$4, repository_selection=$5,
                   suspended_at=$6, removed_at=NULL, checked_at=now(), updated_at=now()
                 WHERE workspace_id=$1 AND installation_id=$2 RETURNING *`
              : `UPDATE github_installations SET removed_at=COALESCE(removed_at, now()), checked_at=now(), updated_at=now()
                 WHERE workspace_id=$1 AND installation_id=$2 RETURNING *`,
            value
              ? [
                  m.principal.workspaceId,
                  row.installation_id,
                  value.accountLogin,
                  value.accountType,
                  value.repositorySelection,
                  value.suspendedAt,
                ]
              : [m.principal.workspaceId, row.installation_id],
          );
          if (updated.rows[0]) out.set(row.installation_id, updated.rows[0]);
        }
        return out;
      },
      { fencingEpoch: m.fencingEpoch, isolation: "read committed" },
    );
    return rows
      .filter(
        (row) =>
          !checked.some((c) => c.row === row) || refreshed.has(row.installation_id),
      )
      .map((row) => record(refreshed.get(row.installation_id) ?? row));
  }

  /**
   * Unbinds an installation from the workspace. Sources that read through it
   * are kept with their bindings, runs and versions and are marked
   * `auth_failed` until the installation is bound again and a sync succeeds.
   */
  async unbind(
    m: Mutation & { installationId: unknown },
  ): Promise<{ sourcesMarked: number }> {
    authorize(m.principal, "workspace:update");
    const installationId = parseInstallationId(m.installationId);
    return withDomainTransaction(
      this.pool,
      m.requestId,
      async ({ client }) => {
        const removed = await client.query(
          "DELETE FROM github_installations WHERE workspace_id=$1 AND installation_id=$2",
          [m.principal.workspaceId, installationId],
        );
        if (!removed.rowCount)
          throw new DomainError(
            "NOT_FOUND",
            "GitHub App installation was not found",
            404,
          );
        const sources = await client.query<{ id: string }>(
          "SELECT id FROM skill_sources WHERE workspace_id=$1 AND github_installation_id=$2 ORDER BY id",
          [m.principal.workspaceId, installationId],
        );
        for (const source of sources.rows)
          await insertPrincipalAudit(client, m.principal, {
            eventType: "skill_source.auth_failed",
            action: "workspace:update",
            outcome: "error",
            requestId: m.requestId,
            resourceType: "skill_source",
            resourceId: source.id,
            metadata: { reason: "auth_failed" },
          });
        await this.audit(client, m, installationId, "unbound", {
          sourcesMarked: sources.rows.length,
        });
        return { sourcesMarked: sources.rows.length };
      },
      { fencingEpoch: m.fencingEpoch },
    );
  }

  /**
   * The bound, active installation a source may read through. A missing,
   * removed or suspended installation is `auth_failed`.
   */
  async activeInstallation(
    client: Pool | PoolClient,
    workspaceId: string,
    installationId: number,
  ): Promise<GitHubInstallation> {
    const row = (
      await client.query<InstallationRow>(
        "SELECT * FROM github_installations WHERE workspace_id=$1 AND installation_id=$2",
        [workspaceId, installationId],
      )
    ).rows[0];
    if (!row || row.removed_at || row.suspended_at) throw new GitHubAuthFailedError();
    return record(row);
  }

  /** Repositories an active bound installation grants, for source creation. */
  async repositories(
    principal: Principal,
    installationIdInput: unknown,
  ): Promise<GitHubInstallationRepository[]> {
    authorize(principal, "workspace:read");
    const installationId = parseInstallationId(installationIdInput);
    await this.activeInstallation(this.pool, principal.workspaceId, installationId);
    const { app } = this.configured();
    const minted = await this.appRequest(
      `/app/installations/${String(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: { metadata: "read" } }),
      },
    );
    if (minted.status === 401 || minted.status === 403 || minted.status === 404) {
      if (await isGitHubRateLimited(minted))
        unavailable("GitHub rate limit reached; retry later");
      await discardBody(minted);
      throw new GitHubAuthFailedError(
        "GitHub App installation access was revoked; reconnect the installation and retry",
      );
    }
    if (minted.status !== 201) {
      await discardBody(minted);
      unavailable("GitHub could not issue an installation token; retry later");
    }
    const token = object(await readJson(minted))?.token;
    if (typeof token !== "string" || !TOKEN.test(token))
      unavailable("GitHub returned an invalid installation token");
    const repositories: GitHubInstallationRepository[] = [];
    for (let page = 1; page <= MAX_REPOSITORY_PAGES; page += 1) {
      const response = await this.github(
        `${app.apiBaseUrl}/installation/repositories?per_page=100&page=${String(page)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (response.status !== 200) {
        await discardBody(response);
        unavailable(
          "GitHub could not list the installation's repositories; retry later",
        );
      }
      const list = object(await readJson(response))?.repositories;
      if (!Array.isArray(list))
        unavailable("GitHub returned an invalid repository list");
      for (const entry of list) {
        const item = object(entry);
        const fullName = item?.full_name;
        if (
          typeof fullName !== "string" ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(fullName)
        )
          continue;
        repositories.push({
          fullName,
          private: item?.private === true,
          defaultBranch:
            typeof item?.default_branch === "string" ? item.default_branch : null,
          url: `https://github.com/${fullName}`,
        });
      }
      if (list.length < 100) break;
    }
    return repositories;
  }
}
