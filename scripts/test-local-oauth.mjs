#!/usr/bin/env node

import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { isMain } from "./lib/production-deployment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function json(response, label) {
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object") {
    throw new Error(`${label} failed with HTTP ${response.status}`);
  }
  return body;
}

async function configuration(options = {}) {
  if (options.issuer && options.resource) {
    assert(
      typeof options.databaseUrl === "string" && options.databaseUrl.length > 0,
      "OAuth verification requires a direct database URL for client cleanup",
    );
    return {
      schemaVersion: 1,
      issuer: options.issuer,
      resource: options.resource,
      databaseUrl: options.databaseUrl,
    };
  }
  const [state, runtime] = await Promise.all([
    readFile(resolve(root, ".data", "local-oauth.json"), "utf8")
      .then((value) => JSON.parse(value))
      .catch((error) => {
        if (error?.code === "ENOENT") {
          throw new Error(
            "Local OAuth is not configured; run pnpm local:oauth:configure first",
          );
        }
        throw error;
      }),
    readFile(resolve(root, ".data", "local-runtime.json"), "utf8")
      .then((value) => JSON.parse(value))
      .catch((error) => {
        if (error?.code === "ENOENT") {
          throw new Error("Local runtime is missing; run pnpm db:up first");
        }
        throw error;
      }),
  ]);
  assert(state.schemaVersion === 1, "Local OAuth configuration has an unknown schema");
  assert(
    typeof runtime.databaseUrl === "string" && runtime.databaseUrl.length > 0,
    "Local runtime omitted databaseUrl",
  );
  return { ...state, databaseUrl: runtime.databaseUrl };
}

function callbackServer(state) {
  let resolveCallback;
  let rejectCallback;
  const callback = new Promise((resolvePromise, rejectPromise) => {
    resolveCallback = resolvePromise;
    rejectCallback = rejectPromise;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/oauth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth state mismatch. Return to the terminal.");
      rejectCallback(new Error("OAuth callback state did not match"));
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth authorization was not completed. Return to the terminal.");
      rejectCallback(
        new Error(`OAuth authorization failed: ${error ?? "missing_code"}`),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Skillplane connected</title><h1>Skillplane connected</h1><p>You can close this tab.</p>",
    );
    resolveCallback(code);
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectPromise(new Error("Could not allocate the OAuth callback port"));
        return;
      }
      resolvePromise({
        callback,
        redirectUri: `http://127.0.0.1:${address.port}/oauth/callback`,
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
      });
    });
  });
}

export function browserLaunchCommand(url, platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export function openBrowser(url) {
  const { command, args } = browserLaunchCommand(url);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", (error) => {
    process.stderr.write(
      `Could not open a browser automatically (${error.message}). Open this URL manually:\n${url}\n`,
    );
  });
  child.unref();
}

export async function waitForOAuthCallback(
  callback,
  timeoutMilliseconds = 600_000,
  timers = { setTimeout, clearTimeout },
) {
  let timeout;
  try {
    return await Promise.race([
      callback,
      new Promise((_, reject) => {
        timeout = timers.setTimeout(
          () =>
            reject(
              new Error(`OAuth browser flow timed out after ${timeoutMilliseconds} ms`),
            ),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) timers.clearTimeout(timeout);
  }
}

export function registrationManagement(registration, issuer) {
  const accessToken = registration.registration_access_token;
  const clientUri = registration.registration_client_uri;
  const hasAccessToken = accessToken !== undefined;
  const hasClientUri = clientUri !== undefined;
  assert(
    hasAccessToken === hasClientUri,
    "Dynamic registration returned incomplete management credentials",
  );
  if (!hasAccessToken) return undefined;
  assert(
    typeof accessToken === "string" && accessToken.length >= 32,
    "Dynamic registration returned an invalid registration_access_token",
  );
  assert(
    typeof clientUri === "string" &&
      new URL(clientUri).origin === new URL(issuer).origin,
    "Dynamic registration returned an invalid registration_client_uri",
  );
  return { accessToken, clientUri };
}

export async function deleteDynamicRegistration(databaseUrl, clientId, options = {}) {
  const PoolConstructor = options.Pool ?? Pool;
  const pool = new PoolConstructor({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `DELETE FROM authfn_oauth_clients
       WHERE client_id = $1 AND source = 'dynamic'
       RETURNING client_id`,
      [clientId],
    );
    assert(result.rowCount === 1, "OAuth client cleanup failed");
  } finally {
    await pool.end();
  }
}

export async function testLocalOAuth(options = {}) {
  const configured = await configuration(options);
  const resourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    configured.resource,
  );
  const protectedMetadata = await json(
    await fetch(resourceMetadataUrl, { signal: AbortSignal.timeout(15_000) }),
    "Protected-resource discovery",
  );
  assert(
    protectedMetadata.resource === configured.resource,
    "MCP resource metadata has the wrong audience",
  );
  assert(
    protectedMetadata.authorization_servers?.[0] === configured.issuer,
    "MCP resource metadata has the wrong authorization server",
  );
  const authorizationMetadata = await json(
    await fetch(`${configured.issuer}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(15_000),
    }),
    "Authorization-server discovery",
  );
  assert(
    authorizationMetadata.issuer === configured.issuer,
    "OAuth issuer metadata does not match",
  );

  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const callback = await callbackServer(state);
  let token;
  let refreshToken;
  let clientId;
  let registrationAccessToken;
  let registrationClientUri;
  let primaryError;
  let cleanupError;
  let verificationResult;
  const client = new McpClient({
    name: "skillplane-local-oauth-verifier",
    version: "1.0.0",
  });
  try {
    const registration = await json(
      await fetch(authorizationMetadata.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          client_name: "Skillplane local OAuth verifier",
          redirect_uris: [callback.redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope: "skills:read contexts:read",
        }),
      }),
      "Dynamic client registration",
    );
    clientId = registration.client_id;
    assert(typeof clientId === "string", "Dynamic registration omitted client_id");
    const management = registrationManagement(registration, configured.issuer);
    registrationAccessToken = management?.accessToken;
    registrationClientUri = management?.clientUri;
    const authorize = new URL(authorizationMetadata.authorization_endpoint);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: callback.redirectUri,
      resource: configured.resource,
      scope: "skills:read contexts:read",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    process.stderr.write(
      `Complete sign-in and consent in the opened browser:\n${authorize.toString()}\n`,
    );
    openBrowser(authorize.toString());
    const code = await waitForOAuthCallback(callback.callback);
    const tokenResponse = await json(
      await fetch(authorizationMetadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: callback.redirectUri,
          resource: configured.resource,
          code,
          code_verifier: verifier,
        }),
      }),
      "OAuth token exchange",
    );
    token = tokenResponse.access_token;
    refreshToken = tokenResponse.refresh_token;
    assert(
      typeof token === "string" && token.length >= 32,
      "Token exchange omitted access_token",
    );
    assert(
      typeof refreshToken === "string" && refreshToken.length >= 32,
      "Token exchange omitted refresh_token",
    );
    const transport = new StreamableHTTPClientTransport(new URL(configured.resource), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const tools = await client.listTools();
    assert(
      tools.tools.some((tool) => tool.name === "workspaces_list"),
      "MCP tool inventory is incomplete",
    );
    const result = await client.callTool({
      name: "workspaces_list",
      arguments: {
        cursor: null,
        limit: 100,
        caller: {
          agentId: "skillplane-local-oauth-verifier",
          agentName: "Skillplane local OAuth verifier",
          modelProvider: "openai",
          modelName: "codex",
          modelVersion: "local-verification",
          clientName: "Skillplane local OAuth verifier",
          clientVersion: "1.0.0",
          runId: `run:local:${randomUUID()}`,
          sessionId: `session:local:${randomUUID()}`,
          conversationId: `conversation:local:${randomUUID()}`,
        },
      },
    });
    assert(result.isError !== true, "Authenticated workspaces_list failed");
    verificationResult = {
      ok: true,
      checkedAt: new Date().toISOString(),
      issuer: configured.issuer,
      resource: configured.resource,
      oauth: {
        discovery: true,
        dynamicRegistration: true,
        registrationCleanup: registrationClientUri
          ? "management-endpoint"
          : "direct-database",
        pkce: "S256",
        tokenExchange: true,
      },
      mcp: { authenticated: true, toolCount: tools.tools.length, workspacesList: true },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (operation) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(
          error instanceof Error ? error : new Error("OAuth cleanup failed"),
        );
      }
    };
    await cleanup(() => client.close());
    await cleanup(() => callback.close());
    await cleanup(async () => {
      const revocationToken = refreshToken ?? token;
      if (revocationToken && authorizationMetadata.revocation_endpoint) {
        const response = await fetch(authorizationMetadata.revocation_endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: revocationToken, client_id: clientId }),
          signal: AbortSignal.timeout(15_000),
        });
        assert(response.ok, "OAuth token revocation failed");
        if (refreshToken) {
          const verification = await fetch(authorizationMetadata.token_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: clientId,
            }),
            signal: AbortSignal.timeout(15_000),
          });
          const body = await verification.json().catch(() => null);
          assert(
            verification.status === 400 && body?.error === "invalid_grant",
            "OAuth refresh token remained usable after revocation",
          );
        }
      }
    });
    await cleanup(async () => {
      if (registrationClientUri && registrationAccessToken) {
        const response = await fetch(registrationClientUri, {
          method: "DELETE",
          headers: { authorization: `Bearer ${registrationAccessToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        assert(response.status === 204, "OAuth client cleanup failed");
      } else if (clientId) {
        await deleteDynamicRegistration(configured.databaseUrl, clientId);
      }
    });
    if (cleanupErrors.length > 0) {
      cleanupError = new AggregateError(
        cleanupErrors,
        "OAuth verification cleanup failed",
      );
      if (primaryError) {
        process.stderr.write(
          `${cleanupError.message}: ${cleanupErrors.map((error) => error.message).join("; ")}\n`,
        );
      }
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return verificationResult;
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await testLocalOAuth(), null, 2)}\n`);
}
