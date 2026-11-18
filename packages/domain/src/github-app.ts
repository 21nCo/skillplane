import { DomainError } from "./errors.js";

/** The REST API version every Skillplane GitHub request pins. */
export const GITHUB_API_VERSION = "2026-03-10";
export const GITHUB_API_BASE_URL = "https://api.github.com";
/** A cached installation token is replaced this long before GitHub expires it. */
export const INSTALLATION_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const USER_AGENT = "Skillplane-github-app";
const REQUEST_TIMEOUT_MS = 10000;
// A token response lists every granted repository as a full repository
// object, so its budget grows with the requested scope.
const TOKEN_RESPONSE_BASE_BYTES = 64 * 1024;
const TOKEN_RESPONSE_BYTES_PER_REPOSITORY = 32 * 1024;
// GitHub accepts at most 500 repositories in one installation token request.
const MAX_TOKEN_REPOSITORIES = 500;
// At most this many unexpired tokens are kept; the least recently used goes.
const MAX_CACHED_TOKENS = 256;
// Legacy (ghs_ plus 36 characters) and stateless (ghs_<app>_<JWT>) tokens:
// only characters that are safe in an Authorization header.
const INSTALLATION_TOKEN = /^[A-Za-z0-9_.-]{20,32768}$/u;

/** Installation token scope: sources read contents, linked sync writes them. */
export type GitHubContentsAccess = "read" | "write";

/**
 * GitHub refused the App installation's access: the installation was removed
 * or suspended, or it no longer covers the repository or permission. Callers
 * mark the source `auth_failed` and keep its data; reconnecting restores it.
 */
export class GitHubAuthFailedError extends DomainError {
  readonly reason = "auth_failed" as const;
  constructor(
    message = "GitHub App installation access to this repository was revoked; reconnect the installation and retry",
  ) {
    super("GIT_SOURCE_AUTH_FAILED", message, 409, { reason: "auth_failed" });
    this.name = "GitHubAuthFailedError";
  }
}

export function isGitHubAuthFailed(error: unknown): error is GitHubAuthFailedError {
  return error instanceof DomainError && error.code === "GIT_SOURCE_AUTH_FAILED";
}

/** The App identity from the Worker secrets named in `@skillplane/config`. */
export interface GitHubAppCredentials {
  readonly appId: string;
  readonly privateKeyPem: string;
}

export interface GitHubAppOptions {
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  /** Test seam for a fake GitHub server; production uses api.github.com. */
  readonly apiBaseUrl?: string;
}

export interface InstallationTokenRequest {
  readonly installationId: number;
  /** `owner/name` of every repository the token may access; one owner. */
  readonly repositories: readonly string[];
  readonly access: GitHubContentsAccess;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

function unavailable(message: string): never {
  throw new DomainError("SERVICE_UNAVAILABLE", message, 503);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [0x80 | bytes.length, ...bytes];
}

// GitHub issues App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"); Web Crypto
// imports only PKCS#8, so wrap the key in a PrivateKeyInfo for rsaEncryption.
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = [
    0x02,
    0x01,
    0x00,
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
    0x04,
    ...derLength(pkcs1.length),
  ];
  const header = [0x30, ...derLength(body.length + pkcs1.length)];
  const out = new Uint8Array(header.length + body.length + pkcs1.length);
  out.set(header);
  out.set(body, header.length);
  out.set(pkcs1, header.length + body.length);
  return out;
}

/**
 * Imports the App private key for RS256 signing with Web Crypto, which works
 * in Workers and Node alike. Errors never include key material.
 */
export async function importGitHubAppPrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replaceAll("\\n", "\n").replaceAll("\r\n", "\n").trim();
  const match =
    /^-----BEGIN (RSA )?PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END \1PRIVATE KEY-----$/u.exec(
      normalized,
    );
  try {
    if (!match) throw new Error("not a PEM private key");
    const der = base64Decode((match[2] ?? "").replaceAll("\n", ""));
    return await crypto.subtle.importKey(
      "pkcs8",
      match[1] ? pkcs1ToPkcs8(der) : der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    unavailable("The GitHub App private key is invalid");
  }
}

/**
 * Signs a GitHub App JWT. `iat` is backdated 60 seconds for clock drift and
 * `exp` stays inside GitHub's 10 minute maximum.
 */
export async function signGitHubAppJwt(
  appId: string,
  key: CryptoKey,
  nowMs: number = Date.now(),
): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const encoder = new TextEncoder();
  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const payload = base64Url(
    encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64Url(new Uint8Array(signature))}`;
}

const REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})$/u;

function tokenScope(request: InstallationTokenRequest) {
  if (!Number.isSafeInteger(request.installationId) || request.installationId <= 0)
    throw new DomainError("VALIDATION_FAILED", "Invalid GitHub App installation", 400);
  // Callers outside TypeScript can pass any access string.
  const access: string = request.access;
  if (access !== "read" && access !== "write")
    throw new DomainError("VALIDATION_FAILED", "Invalid GitHub contents access", 400);
  const names = new Map<string, string>();
  let owner: string | null = null;
  for (const repository of request.repositories) {
    const match = REPOSITORY.exec(repository);
    if (!match || match[2] === "." || match[2] === "..")
      throw new DomainError("VALIDATION_FAILED", "Invalid GitHub repository", 400);
    const login = (match[1] ?? "").toLowerCase();
    if (owner !== null && owner !== login)
      throw new DomainError(
        "VALIDATION_FAILED",
        "An installation token covers repositories of one owner",
        400,
      );
    owner = login;
    names.set(repository.toLowerCase(), match[2] ?? "");
  }
  if (names.size === 0 || names.size > MAX_TOKEN_REPOSITORIES)
    throw new DomainError(
      "VALIDATION_FAILED",
      "An installation token needs between 1 and 500 repositories",
      400,
    );
  const fullNames = [...names.keys()].sort();
  // A snapshot of the request: later changes to the caller's object never
  // change what is minted, validated or cached under this key.
  return {
    installationId: request.installationId,
    access: request.access,
    key: `${String(request.installationId)}:${access}:${fullNames.join(",")}`,
    fullNames,
    names: fullNames.map((fullName) => names.get(fullName) ?? ""),
  };
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) unavailable("GitHub returned an empty response");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        unavailable("GitHub returned an oversized response");
      }
      parts.push(next.value);
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    unavailable("GitHub response was interrupted; retry later");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    unavailable("GitHub returned invalid JSON");
  }
}

// GitHub names primary ("API rate limit exceeded") and secondary ("You have
// exceeded a secondary rate limit") limits in the error message; secondary
// limits may come without any rate limit header.
const RATE_LIMIT_MESSAGE = /rate limit|abuse detection|spam/iu;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** Whether a GitHub error message names a rate limit or abuse protection. */
export function isRateLimitMessage(message: unknown): boolean {
  return typeof message === "string" && RATE_LIMIT_MESSAGE.test(message);
}

/** Releases an unread body; a failure to do so never replaces the outcome. */
export async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

// The error body's text, or null when it could not be read to the end.
async function errorText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const next = await reader.read();
      if (next.done) return text;
      size += next.value.byteLength;
      text += decoder.decode(next.value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  return text;
}

/**
 * Whether a refused response is GitHub throttling rather than a permission
 * refusal: any 429, or a 403 with an exhausted rate limit, a `retry-after`
 * header or a message naming a primary or secondary rate limit. A 403 whose
 * body could not be read is not a confirmed refusal and counts as throttling
 * (retryable). Consumes the response body; the text is only matched, never
 * echoed.
 */
export async function isGitHubRateLimited(response: Response): Promise<boolean> {
  if (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")))
  ) {
    await discardBody(response);
    return true;
  }
  if (response.status !== 403) {
    await discardBody(response);
    return false;
  }
  const text = await errorText(response);
  return text === null || RATE_LIMIT_MESSAGE.test(text);
}

/**
 * Classifies a 403 or 429 from GitHub: throttling is a retryable outage and
 * any other refusal means the installation does not grant the access.
 */
export async function throwGitHubRefusal(response: Response): Promise<never> {
  if (await isGitHubRateLimited(response))
    unavailable("GitHub rate limit reached; retry later");
  throw new GitHubAuthFailedError();
}

/**
 * Acts as the Skillplane GitHub App: signs App JWTs and mints installation
 * tokens limited to the requested repositories and contents permission.
 * A token is reused until five minutes before it expires; the in-memory cache
 * drops it then (or earlier, beyond its most recent 256 scopes). Tokens are
 * never persisted, logged or placed in an error.
 */
export class GitHubApp {
  readonly apiBaseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  // Secrets and tokens live in private fields, so neither JSON nor an
  // inspected or logged GitHubApp exposes them.
  readonly #credentials: GitHubAppCredentials;
  #key: Promise<CryptoKey> | null = null;
  readonly #tokens = new Map<string, CachedToken>();
  readonly #pending = new Map<string, Promise<CachedToken>>();

  constructor(credentials: GitHubAppCredentials, options: GitHubAppOptions = {}) {
    this.#credentials = {
      appId: credentials.appId,
      privateKeyPem: credentials.privateKeyPem,
    };
    // workerd rejects fetch called with a receiver other than the global scope.
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    const base = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
    let end = base.length;
    while (end > 0 && base[end - 1] === "/") end -= 1;
    this.apiBaseUrl = base.slice(0, end);
  }

  /** How many installation tokens the cache holds (never their values). */
  get cachedTokenCount(): number {
    return this.#tokens.size;
  }

  /** A freshly signed App JWT for App-level endpoints. */
  async appJwt(): Promise<string> {
    this.#key ??= importGitHubAppPrivateKey(this.#credentials.privateKeyPem).catch(
      (error: unknown) => {
        this.#key = null;
        throw error;
      },
    );
    return signGitHubAppJwt(this.#credentials.appId, await this.#key, this.now());
  }

  /**
   * An installation token for exactly the requested repositories and
   * contents access. Concurrent callers for the same scope share one mint.
   */
  async installationToken(request: InstallationTokenRequest): Promise<string> {
    const scope = tokenScope(request);
    const now = this.now();
    for (const [key, entry] of this.#tokens)
      if (now >= entry.expiresAt - INSTALLATION_TOKEN_REFRESH_MARGIN_MS)
        this.#tokens.delete(key);
    const cached = this.#tokens.get(scope.key);
    if (cached) {
      // Most recently used last, so eviction drops the least recently used.
      this.#tokens.delete(scope.key);
      this.#tokens.set(scope.key, cached);
      return cached.token;
    }
    let pending = this.#pending.get(scope.key);
    if (!pending) {
      const minting = this.mint(scope).then((minted) => {
        if (this.now() < minted.expiresAt - INSTALLATION_TOKEN_REFRESH_MARGIN_MS) {
          this.#tokens.delete(scope.key);
          this.#tokens.set(scope.key, minted);
          for (const key of this.#tokens.keys()) {
            if (this.#tokens.size <= MAX_CACHED_TOKENS) break;
            this.#tokens.delete(key);
          }
        }
        return minted;
      });
      pending = minting.finally(() => {
        if (this.#pending.get(scope.key) === pending) this.#pending.delete(scope.key);
      });
      this.#pending.set(scope.key, pending);
    }
    return (await pending).token;
  }

  /** Drops a cached token GitHub rejected, unless a newer one replaced it. */
  invalidate(request: InstallationTokenRequest, token: string): void {
    const scope = tokenScope(request);
    if (this.#tokens.get(scope.key)?.token === token) this.#tokens.delete(scope.key);
  }

  /**
   * Sends an installation-authenticated request. A rejected (401) token is
   * replaced once with a fresh mint; a second rejection, or a permission
   * refusal (403 that is not throttling), is `auth_failed`. Throttling (429,
   * or a rate limited 403) is a retryable SERVICE_UNAVAILABLE.
   */
  async installationFetch(
    request: InstallationTokenRequest,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    if (!url.startsWith(`${this.apiBaseUrl}/`))
      throw new DomainError("VALIDATION_FAILED", "Invalid GitHub API request", 400);
    // Mint and invalidate for the request as it was when this call began.
    request = {
      installationId: request.installationId,
      repositories: [...request.repositories],
      access: request.access,
    };
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.installationToken(request);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      headers.set("x-github-api-version", GITHUB_API_VERSION);
      if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
      let response: Response;
      try {
        response = await this.fetcher(url, { ...init, headers, redirect: "manual" });
      } catch {
        unavailable("GitHub could not be reached; retry later");
      }
      if (response.status === 401) {
        await discardBody(response);
        this.invalidate(request, token);
        if (attempt === 0) continue;
        throw new GitHubAuthFailedError();
      }
      if (response.status === 403 || response.status === 429)
        await throwGitHubRefusal(response);
      return response;
    }
  }

  private async mint(scope: ReturnType<typeof tokenScope>): Promise<CachedToken> {
    const jwt = await this.appJwt();
    let response: Response;
    try {
      response = await this.fetcher(
        `${this.apiBaseUrl}/app/installations/${String(scope.installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "content-type": "application/json",
            "user-agent": USER_AGENT,
            "x-github-api-version": GITHUB_API_VERSION,
          },
          body: JSON.stringify({
            repositories: scope.names,
            permissions: { contents: scope.access },
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
    } catch {
      unavailable("GitHub could not be reached; retry later");
    }
    if (!response.ok) {
      // 403: suspended or not permitted, unless it is throttling.
      if (response.status === 403 || response.status === 429)
        await throwGitHubRefusal(response);
      // 422: a repository or permission outside the installation, but only
      // when GitHub says so; spam protection, throttling or an unreadable body
      // is retryable.
      if (response.status === 422) {
        const text = await errorText(response);
        if (
          text !== null &&
          !RATE_LIMIT_MESSAGE.test(text) &&
          /not accessible|not granted|does not exist/iu.test(text)
        )
          throw new GitHubAuthFailedError();
        unavailable("GitHub could not issue an installation token; retry later");
      }
      await discardBody(response);
      // 404: the installation was removed.
      if (response.status === 404) throw new GitHubAuthFailedError();
      if (response.status === 401)
        unavailable("GitHub rejected the Skillplane App credentials");
      unavailable("GitHub could not issue an installation token; retry later");
    }
    const body = await boundedJson(
      response,
      TOKEN_RESPONSE_BASE_BYTES +
        scope.fullNames.length * TOKEN_RESPONSE_BYTES_PER_REPOSITORY,
    );
    const row =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const token = row.token,
      expiresAt =
        typeof row.expires_at === "string" ? Date.parse(row.expires_at) : Number.NaN;
    if (
      typeof token !== "string" ||
      !INSTALLATION_TOKEN.test(token) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now()
    )
      unavailable("GitHub returned an invalid installation token");
    // Refuse a token whose grant differs from the request: the permissions must
    // be exactly the requested contents access plus, optionally, the
    // metadata: read that GitHub adds implicitly, and the repository set must
    // match. Anything else (another permission, a different contents access or
    // repository set) is a wrongly scoped token and is neither returned nor
    // cached.
    const permissions = row.permissions;
    const grantMatches =
      permissions !== null &&
      typeof permissions === "object" &&
      !Array.isArray(permissions) &&
      Object.entries(permissions as Record<string, unknown>).every(([name, value]) =>
        name === "contents"
          ? value === scope.access
          : name === "metadata" && value === "read",
      ) &&
      (permissions as Record<string, unknown>).contents === scope.access;
    const repositories = Array.isArray(row.repositories)
      ? row.repositories.map((repository: unknown) =>
          typeof repository === "object" && repository !== null
            ? String((repository as Record<string, unknown>).full_name).toLowerCase()
            : "",
        )
      : [];
    if (
      !grantMatches ||
      repositories.length !== scope.fullNames.length ||
      [...repositories].sort().some((name, index) => name !== scope.fullNames[index])
    )
      throw new GitHubAuthFailedError(
        "The GitHub App installation does not grant the requested repository access",
      );
    return { token, expiresAt };
  }
}
