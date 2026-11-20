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
// An installation token response can list every repository of a large grant.
const MAX_TOKEN_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_INSTALLATIONS = 20;
// Repository pages read per listing call; `nextCursor` continues past them.
const MAX_REPOSITORY_PAGES = 5;
const REPOSITORY_CURSOR = /^[1-9][0-9]{0,3}$/u;
const STATE_PURPOSE = "github-install-state";
// Consumed nonces are kept this long past their state's expiry.
const STATE_RETENTION = "1 day";
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
  /** Organization Members: read, which membership reads need, is granted. */
  readonly membersReadable: boolean;
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

function replayed(): never {
  throw new DomainError(
    "GITHUB_INSTALL_STATE_REPLAYED",
    "The GitHub install link was already used; start again",
    409,
  );
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

// Reads a JSON body, refusing an oversized one as it streams, whatever its length.
async function readJson(
  response: Response,
  limit = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > limit) {
    await discardBody(response);
    unavailable("GitHub returned an oversized response");
  }
  const chunks: Uint8Array[] = [];
  let size = 0,
    oversized = false;
  try {
    const reader = response.body?.getReader();
    for (
      let next = await reader?.read();
      next && !next.done;
      next = await reader?.read()
    ) {
      size += next.value.byteLength;
      if (size > limit) {
        oversized = true;
        await reader?.cancel().catch(() => undefined);
        break;
      }
      chunks.push(next.value);
    }
  } catch {
    unavailable();
  }
  if (oversized) unavailable("GitHub returned an oversized response");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    unavailable("GitHub returned an invalid response");
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const GITHUB_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u;

// A GitHub timestamp in UTC ISO; null unless every field is real (not Date.parse).
function githubTime(value: string): string | null {
  const match = GITHUB_TIME.exec(value);
  if (!match) return null;
  const field = (index: number) => Number(match[index] ?? "0");
  const [year, month, day] = [field(1), field(2) - 1, field(3)];
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month &&
    date.getUTCDate() === day &&
    field(4) < 24 &&
    field(5) < 60 &&
    field(6) < 60 &&
    field(7) < 24 &&
    field(8) < 60
    ? new Date(value).toISOString()
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
    (suspended !== null && typeof suspended !== "string") ||
    // An unreadable suspension is no observation, never a resumption.
    (typeof suspended === "string" && !githubTime(suspended))
  )
    return null;
  const suspendedAt = typeof suspended === "string" ? githubTime(suspended) : null;
  const members = object(body?.permissions)?.members;
  return {
    accountLogin: login,
    accountType: type,
    repositorySelection: selection,
    suspendedAt,
    membersReadable: members === "read" || members === "write",
  };
}

/** Whether a Link header names a next page of `listing` on its API host. */
function nextPageLinked(link: string | null, listing: string): boolean {
  const expected = new URL(listing);
  // Split links on "," and parameters on ";" outside <targets> and "quotes".
  const links: string[][] = [[""]];
  let quoted = false,
    target = false,
    escaped = false;
  for (const c of link ?? "") {
    const parts = links[links.length - 1] ?? [];
    if (!quoted && !target && (c === "," || c === ";")) {
      if (c === ",") links.push([""]);
      else parts.push("");
      continue;
    }
    if (escaped) escaped = false;
    else if (quoted && c === "\\") escaped = true;
    else if (c === '"' && !target) quoted = !quoted;
    else if (!quoted) target = c === "<" ? true : c === ">" ? false : target;
    parts.push(`${parts.pop() ?? ""}${c}`);
  }
  return links.some(([uri = "", ...params]) => {
    const next = params.some((p) => {
      const [key = "", rel = ""] = p.split("=", 2).map((v) => v.trim());
      return (
        key.toLowerCase() === "rel" &&
        rel.replaceAll('"', "").toLowerCase().split(" ").includes("next")
      );
    });
    const value = uri.trim();
    if (!next || !value.startsWith("<") || !value.endsWith(">")) return false;
    try {
      const url = new URL(value.slice(1, -1), expected);
      return url.origin === expected.origin && url.pathname === expected.pathname;
    } catch {
      return false;
    }
  });
}

// GitHub refused the installation's access; a rate limit is only a retry.
async function revoked(response: Response): Promise<never> {
  if (await isGitHubRateLimited(response))
    unavailable("GitHub rate limit reached; retry later");
  await discardBody(response);
  throw new GitHubAuthFailedError(
    "GitHub App installation access was revoked; reconnect the installation and retry",
  );
}

function boundElsewhere(): never {
  throw new DomainError(
    "GITHUB_INSTALLATION_BOUND_ELSEWHERE",
    "This GitHub App installation is already connected to another workspace",
    409,
  );
}

/**
 * Fences sources reading through an installation that stops being usable: a
 * new revision voids previews, a cleared lease voids applies (locked by id).
 */
async function fenceInstallationSources(
  client: PoolClient,
  workspaceId: string,
  installationId: number,
): Promise<{ id: string }[]> {
  const sources = await client.query<{ id: string }>(
    "SELECT id FROM skill_sources WHERE workspace_id=$1 AND github_installation_id=$2 ORDER BY id FOR UPDATE",
    [workspaceId, installationId],
  );
  await client.query(
    "UPDATE skill_sources SET revision=revision+1,sync_token=NULL,sync_expires_at=NULL,updated_at=now() WHERE workspace_id=$1 AND github_installation_id=$2",
    [workspaceId, installationId],
  );
  return sources.rows;
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

  // Reading bound installations needs only the App; installing, its settings.
  private configured(): { app: GitHubApp; settings: GitHubInstallSettings };
  private configured(appOnly: true): { app: GitHubApp };
  private configured(appOnly = false) {
    const { app, settings } = this.#options;
    if (!app || (!settings && !appOnly))
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
    // The OAuth exchange asks for JSON; it is form-encoded under any other Accept.
    if (!headers.has("accept")) headers.set("accept", "application/vnd.github+json");
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

  private async appRequest(
    path: string,
    init: RequestInit = {},
    signed: () => Promise<unknown> = () => Promise.resolve(),
  ): Promise<Response> {
    const { app } = this.configured(true);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await app.appJwt()}`);
    await signed();
    return this.github(`${app.apiBaseUrl}${path}`, { ...init, headers });
  }

  /**
   * The installation as GitHub reports it now (null when removed), with
   * `observedFrom`, the database time right before the request, for ordering.
   */
  private async fetchInstallation(
    installationId: number,
  ): Promise<{ observed: ObservedInstallation | null; observedFrom: string }> {
    let observedFrom = "";
    const response = await this.appRequest(
      `/app/installations/${String(installationId)}`,
      {},
      async () => (observedFrom = await this.databaseNow()),
    );
    if (response.status === 404) {
      await discardBody(response);
      return { observed: null, observedFrom };
    }
    if (response.status !== 200) {
      if (await isGitHubRateLimited(response))
        unavailable("GitHub rate limit reached; retry later");
      await discardBody(response);
      unavailable("GitHub could not return the installation; retry later");
    }
    const observed = observedInstallation(await readJson(response));
    if (!observed) unavailable("GitHub returned an invalid installation");
    return { observed, observedFrom };
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

  /**
   * Whether the OAuth user owns the User installation's account or is an active
   * admin of its Organization; any other or inconclusive answer is no.
   */
  private async administers(
    settings: GitHubInstallSettings,
    token: string,
    observed: ObservedInstallation,
  ): Promise<boolean> {
    const login = observed.accountLogin.toLowerCase();
    const read = async (path: string) => {
      const response = await this.github(`${settings.apiBaseUrl}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 200) return object(await readJson(response));
      await discardBody(response);
      return null;
    };
    try {
      if (observed.accountType === "User") {
        const user = await read("/user");
        return typeof user?.login === "string" && user.login.toLowerCase() === login;
      }
      if (observed.accountType !== "Organization") return false;
      const membership = await read(
        `/user/memberships/orgs/${encodeURIComponent(observed.accountLogin)}`,
      );
      const org = object(membership?.organization)?.login;
      return (
        membership?.state === "active" &&
        membership.role === "admin" &&
        typeof org === "string" &&
        org.toLowerCase() === login
      );
    } catch {
      return false;
    }
  }

  /** The database's current time, which orders installation observations. */
  private async databaseNow(): Promise<string> {
    const now = (
      await this.pool.query<{ now: string }>("SELECT clock_timestamp()::text AS now")
    ).rows[0]?.now;
    if (!now) unavailable();
    return now;
  }

  /**
   * Completes the GitHub install redirect. The state must be valid, unexpired,
   * unused and issued to this user for this workspace; the user must still be
   * an owner or admin here and must administer the installation's account on
   * GitHub (see administers). An installation bound to another workspace is
   * refused.
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
    const nonce = claims.n;
    const expiresAt = new Date(claims.e);
    // Reserve the nonce (consumed_at 'infinity') before the one-use OAuth
    // exchange: a duplicate or expired state is refused without asking GitHub.
    await withDomainTransaction(
      this.pool,
      m.requestId,
      async ({ client }) => {
        const inserted = await client.query(
          "INSERT INTO github_installation_states(nonce,workspace_id,expires_at,consumed_at) VALUES($1,$2,$3,'infinity') ON CONFLICT (nonce) DO NOTHING",
          [nonce, claims.w, expiresAt],
        );
        if (!inserted.rowCount) replayed();
      },
      { fencingEpoch: m.fencingEpoch },
    );
    let bound = false;
    try {
      // Judged once the reservation (and any wait on it) committed.
      const fresh = await this.pool.query<{ fresh: boolean }>(
        "SELECT $1::timestamptz > clock_timestamp() AS fresh",
        [expiresAt],
      );
      if (!fresh.rows[0]?.fresh) invalidState();
      const token = await this.userToken(settings, m.code);
      const { observed, observedFrom } = await this.fetchInstallation(installationId);
      if (observed?.accountType === "Organization" && !observed.membersReadable)
        throw new DomainError(
          "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
          "The GitHub App needs the organization permission Members: read to confirm an organization admin; accept it for this installation on GitHub, then connect again",
          403,
        );
      if (!observed || !(await this.administers(settings, token, observed)))
        throw new DomainError(
          "GITHUB_INSTALLATION_NOT_ACCESSIBLE",
          "Only an owner of this GitHub account or an admin of this organization can connect it",
          403,
        );
      const installation = await this.bind(
        m,
        claims,
        installationId,
        observed,
        observedFrom,
      );
      bound = true;
      return installation;
    } finally {
      // Refusals release it at the routed epoch; a crash strands a short-lived state.
      if (!bound)
        await withDomainTransaction(
          this.pool,
          m.requestId,
          ({ client }) =>
            client.query(
              "DELETE FROM github_installation_states WHERE nonce=$1 AND consumed_at='infinity'",
              [nonce],
            ),
          { fencingEpoch: m.fencingEpoch },
        ).catch(() => undefined);
    }
  }

  /** Binds under the reserved nonce, consumed last and only while fresh. */
  private bind(
    m: Mutation,
    claims: StateClaims,
    installationId: number,
    observed: ObservedInstallation,
    observedFrom: string,
  ): Promise<GitHubInstallation> {
    return withDomainTransaction(
      this.pool,
      m.requestId,
      async ({ client }) => {
        const workspaceId = m.principal.workspaceId;
        // A used nonce is pruned, with a binding, long after its state expired.
        await client.query(
          `DELETE FROM github_installation_states WHERE workspace_id=$1 AND expires_at < now() - interval '${STATE_RETENTION}'`,
          [workspaceId],
        );
        // Serializes this workspace's binds so the installation cap holds.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `github-installations:${workspaceId}`,
        ]);
        const existing = (
          await client.query<InstallationRow>(
            "SELECT * FROM github_installations WHERE installation_id=$1 FOR UPDATE",
            [installationId],
          )
        ).rows[0];
        let row: InstallationRow | undefined;
        if (existing) {
          if (existing.workspace_id !== workspaceId) boundElsewhere();
          // Binding again records this observation unless a newer one landed.
          row =
            (await this.observe(client, existing, observedFrom, observed)) ?? existing;
        } else {
          const count = await client.query<{ count: string }>(
            "SELECT count(*) AS count FROM github_installations WHERE workspace_id=$1",
            [workspaceId],
          );
          if (Number(count.rows[0]?.count ?? 0) >= MAX_INSTALLATIONS)
            throw new DomainError(
              "GITHUB_INSTALLATION_LIMIT_REACHED",
              `A workspace can connect at most ${String(MAX_INSTALLATIONS)} GitHub App installations; disconnect one first`,
              409,
            );
          row = (
            await client.query<InstallationRow>(
              `INSERT INTO github_installations
                 (installation_id,workspace_id,account_login,account_type,repository_selection,suspended_at,bound_by,checked_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)
               ON CONFLICT (installation_id) DO NOTHING
               RETURNING *`,
              [
                installationId,
                workspaceId,
                observed.accountLogin,
                observed.accountType,
                observed.repositorySelection,
                observed.suspendedAt,
                m.principal.actorId,
                observedFrom,
              ],
            )
          ).rows[0];
          // Another workspace bound it concurrently.
          if (!row) boundElsewhere();
        }
        await this.audit(client, m, installationId, "bound", {
          accountLogin: observed.accountLogin,
        });
        const consumed = await client.query(
          "UPDATE github_installation_states SET consumed_at=clock_timestamp() WHERE nonce=$1 AND workspace_id=$2 AND consumed_at='infinity' AND expires_at > clock_timestamp()",
          [claims.n, claims.w],
        );
        if (!consumed.rowCount) invalidState();
        return record(row);
      },
      { fencingEpoch: m.fencingEpoch },
    );
  }

  /**
   * Records an observation of a locked row (null: removed) unless a newer one
   * landed since `observedFrom`; an active installation becoming suspended or
   * removed fences its sources. Returns the updated row, null when stale.
   */
  private async observe(
    client: PoolClient,
    current: InstallationRow,
    observedFrom: string,
    observed: ObservedInstallation | null,
  ): Promise<InstallationRow | null> {
    const updated = (
      await client.query<InstallationRow>(
        observed
          ? `UPDATE github_installations SET account_login=$4, account_type=$5, repository_selection=$6,
               suspended_at=$7, removed_at=NULL, checked_at=$3::timestamptz,
               updated_at=CASE WHEN removed_at IS NOT NULL OR suspended_at IS DISTINCT FROM $7::timestamptz
                 OR account_login<>$4 OR account_type<>$5 OR repository_selection<>$6
                 THEN clock_timestamp() ELSE updated_at END
             WHERE workspace_id=$1 AND installation_id=$2 AND checked_at < $3::timestamptz RETURNING *`
          : `UPDATE github_installations SET removed_at=COALESCE(removed_at, now()), checked_at=$3::timestamptz,
               updated_at=CASE WHEN removed_at IS NULL THEN clock_timestamp() ELSE updated_at END
             WHERE workspace_id=$1 AND installation_id=$2 AND checked_at < $3::timestamptz RETURNING *`,
        observed
          ? [
              current.workspace_id,
              current.installation_id,
              observedFrom,
              observed.accountLogin,
              observed.accountType,
              observed.repositorySelection,
              observed.suspendedAt,
            ]
          : [current.workspace_id, current.installation_id, observedFrom],
      )
    ).rows[0];
    if (!updated) return null;
    if (
      !current.removed_at &&
      !current.suspended_at &&
      (updated.removed_at || updated.suspended_at)
    )
      await fenceInstallationSources(
        client,
        current.workspace_id,
        Number(current.installation_id),
      );
    return updated;
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
    const select = (client: Pool | PoolClient) =>
      client.query<InstallationRow & { created_key: string }>(
        "SELECT *, created_at::text AS created_key FROM github_installations WHERE workspace_id=$1 ORDER BY created_at, installation_id LIMIT $2",
        [m.principal.workspaceId, MAX_INSTALLATIONS],
      );
    const rows = (await select(this.pool)).rows;
    if (!this.#options.app || rows.length === 0) return rows.map(record);
    const observed = await Promise.all(
      rows.map((row) =>
        this.fetchInstallation(Number(row.installation_id)).then(
          (value) => ({ row, ...value, ok: true as const }),
          () => ({ row, observed: null, observedFrom: "", ok: false as const }),
        ),
      ),
    );
    const checked = observed.filter((entry) => entry.ok);
    // Nothing usable from GitHub: the stored state as it is now.
    if (checked.length === 0) return (await select(this.pool)).rows.map(record);
    return withDomainTransaction(
      this.pool,
      m.requestId,
      async ({ client }) => {
        for (const { row, observed: value, observedFrom } of checked) {
          // Only the observed row: one unbound and bound again is a new row.
          const current = (
            await client.query<InstallationRow>(
              "SELECT * FROM github_installations WHERE workspace_id=$1 AND installation_id=$2 AND created_at=$3::timestamptz FOR UPDATE",
              [m.principal.workspaceId, row.installation_id, row.created_key],
            )
          ).rows[0];
          if (current) await this.observe(client, current, observedFrom, value);
        }
        return (await select(client)).rows.map(record);
      },
      { fencingEpoch: m.fencingEpoch, isolation: "read committed" },
    );
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
        const sources = await fenceInstallationSources(
          client,
          m.principal.workspaceId,
          installationId,
        );
        for (const source of sources)
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
          sourcesMarked: sources.length,
        });
        return { sourcesMarked: sources.length };
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

  /**
   * An active binding's repositories, MAX_REPOSITORY_PAGES pages from `cursor`
   * (`nextCursor` reads on), returned only if the binding is unchanged after.
   */
  async repositories(
    principal: Principal,
    installationIdInput: unknown,
    cursorInput: unknown = null,
  ): Promise<{
    repositories: GitHubInstallationRepository[];
    truncated: boolean;
    nextCursor: string | null;
  }> {
    authorize(principal, "workspace:read");
    const installationId = parseInstallationId(installationIdInput);
    if (
      cursorInput !== null &&
      cursorInput !== undefined &&
      (typeof cursorInput !== "string" || !REPOSITORY_CURSOR.test(cursorInput))
    )
      throw new DomainError("VALIDATION_FAILED", "Invalid repository cursor", 400, {
        field: "cursor",
      });
    const first = typeof cursorInput === "string" ? Number(cursorInput) : 1;
    // The active binding, then the same one unchanged: a rebind is a new row,
    // and any status or account change (even one undone since) advances it.
    let bound: string | null = null;
    const binding = () =>
      this.pool.query<{ generation: string }>(
        "SELECT updated_at::text AS generation FROM github_installations WHERE workspace_id=$1 AND installation_id=$2 AND ($3::text IS NULL OR updated_at=$3::timestamptz) AND removed_at IS NULL AND suspended_at IS NULL",
        [principal.workspaceId, installationId, bound],
      );
    bound = (await binding()).rows[0]?.generation ?? null;
    if (!bound) throw new GitHubAuthFailedError();
    const { app } = this.configured(true);
    const minted = await this.appRequest(
      `/app/installations/${String(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ permissions: { metadata: "read" } }),
      },
    );
    // 401 is the App's own credential failing, not the installation.
    if (minted.status === 403 || minted.status === 404) await revoked(minted);
    if (minted.status !== 201) {
      await discardBody(minted);
      unavailable("GitHub could not issue an installation token; retry later");
    }
    const token = object(await readJson(minted, MAX_TOKEN_RESPONSE_BYTES))?.token;
    if (typeof token !== "string" || !TOKEN.test(token))
      unavailable("GitHub returned an invalid installation token");
    const repositories: GitHubInstallationRepository[] = [];
    const listing = `${app.apiBaseUrl}/installation/repositories`;
    // Whether GitHub has repositories past the last page read.
    let more = false,
      page = first;
    for (; page < first + MAX_REPOSITORY_PAGES; page += 1) {
      const response = await this.github(
        `${listing}?per_page=100&page=${String(page)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      // The installation token refused: access was revoked or narrowed.
      if ([401, 403, 404].includes(response.status)) await revoked(response);
      if (response.status !== 200) {
        await discardBody(response);
        unavailable(
          "GitHub could not list the installation's repositories; retry later",
        );
      }
      const body = object(await readJson(response));
      const list = body?.repositories;
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
      // GitHub's next link, not total_count or a full page, says more follow.
      more = nextPageLinked(response.headers.get("link"), listing);
      if (!more) break;
    }
    // An unbind, rebind or suspension while listing withholds the result.
    if (!(await binding()).rowCount) throw new GitHubAuthFailedError();
    const next = String(page);
    return {
      repositories,
      truncated: more,
      nextCursor: more && REPOSITORY_CURSOR.test(next) ? next : null,
    };
  }
}
