#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    return { schemaVersion: 1, issuer: options.issuer, resource: options.resource };
  }
  const state = JSON.parse(
    await readFile(resolve(root, ".data", "local-oauth.json"), "utf8").catch(
      (error) => {
        if (error?.code === "ENOENT") {
          throw new Error(
            "Local OAuth is not configured; run pnpm local:oauth:configure first",
          );
        }
        throw error;
      },
    ),
  );
  assert(state.schemaVersion === 1, "Local OAuth configuration has an unknown schema");
  return state;
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

function openBrowser(url) {
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function waitForOAuthCallback(callback, timeoutMilliseconds = 600_000) {
  let timeout;
  try {
    return await Promise.race([
      callback,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("OAuth browser flow timed out after 10 minutes")),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
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
  let clientId;
  const client = new Client({
    name: "skillplane-local-oauth-verifier",
    version: "1.0.0",
  });
  try {
    const registration = await json(
      await fetch(authorizationMetadata.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
    assert(
      typeof token === "string" && token.length >= 32,
      "Token exchange omitted access_token",
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
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      issuer: configured.issuer,
      resource: configured.resource,
      oauth: {
        discovery: true,
        dynamicRegistration: true,
        pkce: "S256",
        tokenExchange: true,
      },
      mcp: { authenticated: true, toolCount: tools.tools.length, workspacesList: true },
    };
  } finally {
    await client.close().catch(() => undefined);
    await callback.close().catch(() => undefined);
    if (token && authorizationMetadata.revocation_endpoint) {
      await fetch(authorizationMetadata.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, client_id: clientId }),
      }).catch(() => undefined);
    }
  }
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(await testLocalOAuth(), null, 2)}\n`);
}
