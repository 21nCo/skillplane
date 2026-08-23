import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
} from "@skillplane/testing";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import { rollupUtcDay, writeAuditEvent } from "@skillplane/observability";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { buildApiServices, createApiApp } from "../../../api/src/index.js";

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

export interface WorkspaceBrowserHarness {
  readonly csrfToken: string;
  readonly email: string;
  readonly invitedCsrfToken: string;
  readonly invitedEmail: string;
  readonly invitedSessionToken: string;
  readonly messages: unknown[];
  readonly origin: string;
  readonly sessionToken: string;
  readonly skillId: string;
  readonly skillSlug: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  seedObservability(): Promise<void>;
  deleteOAuthClient(clientId: string): Promise<void>;
  close(): Promise<void>;
}

async function toRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const value of request) {
    if (typeof value === "string") {
      chunks.push(Buffer.from(value));
    } else if (value instanceof Uint8Array) {
      chunks.push(Buffer.from(value));
    }
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  return new Request(
    `http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`,
    {
      method,
      headers,
      ...(["GET", "HEAD"].includes(method) ? {} : { body: Buffer.concat(chunks) }),
    },
  );
}

async function writeResponse(
  response: Response,
  target: ServerResponse,
): Promise<void> {
  target.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") target.setHeader(name, value);
  }
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) target.setHeader("set-cookie", setCookies);
  target.end(Buffer.from(await response.arrayBuffer()));
}

function listen(server: Server): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Workspace browser harness did not bind a port"));
        return;
      }
      resolvePromise(address.port);
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}

export async function startWorkspaceBrowserHarness(): Promise<WorkspaceBrowserHarness> {
  const databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  const suffix = `workspace-browser-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const invitedSuffix = `${suffix}-invited`;
  const fixture = await seedTenantFixture(databaseUrl, suffix);
  const invitedFixture = await seedTenantFixture(databaseUrl, invitedSuffix);
  const email = `${suffix}@example.test`;
  const invitedEmail = `${invitedSuffix}@example.test`;
  const messages: unknown[] = [];
  const appRoot = resolve(projectRoot, "app");
  const originalWorkingDirectory = process.cwd();
  process.chdir(appRoot);
  let vite: ViteDevServer;
  try {
    vite = await createViteServer({
      root: appRoot,
      configFile: resolve(appRoot, "vite.config.ts"),
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
      logLevel: "error",
    });
  } finally {
    process.chdir(originalWorkingDirectory);
  }

  const apiState: { value?: ReturnType<typeof createApiApp> } = {};
  const server = createHttpServer((incoming, outgoing) => {
    void (async () => {
      if (
        incoming.url?.startsWith("/api/") ||
        incoming.url?.startsWith("/auth/") ||
        incoming.url?.startsWith("/datafn/")
      ) {
        if (!apiState.value) {
          outgoing.statusCode = 503;
          outgoing.end("The workspace test application is starting");
          return;
        }
        await writeResponse(
          await apiState.value.fetch(await toRequest(incoming)),
          outgoing,
        );
        return;
      }
      vite.middlewares(incoming, outgoing, (error: unknown) => {
        if (error) {
          outgoing.statusCode = 500;
          outgoing.end("The workspace test application could not be rendered");
        }
      });
    })().catch(() => {
      outgoing.statusCode = 500;
      outgoing.end("The workspace test application could not be served");
    });
  });
  const port = await listen(server);
  const origin = `http://localhost:${port}`;
  const services = await (async () => {
    let initialized: Awaited<ReturnType<typeof buildApiServices>> | undefined;
    try {
      const built = await buildApiServices({
        RUNTIME_ENV: "local",
        DATABASE_ADAPTER: "postgres",
        AUTH_MODE: "otp",
        DATABASE_URL: databaseUrl,
        SKILL_BUNDLES: new TestObjectStorage(),
        OAUTH_ISSUER: origin,
        OAUTH_RESOURCE: `${origin}/mcp`,
        EMAIL_PROVIDER: "cloudflare-email",
        AUTHFN_SECRET: "workspace-browser-authfn-secret-32-characters",
        TURNSTILE_SECRET_KEY: "workspace-browser-turnstile-secret-value",
        TURNSTILE_ALLOWED_HOSTNAMES: "localhost",
        PUBLIC_TURNSTILE_SITE_KEY: "workspace-browser-site-key",
        SKILLPLANE_OTP_FROM: "Skillplane <no-reply@auth.skillplane.dev>",
        SEND_EMAIL: {
          send(message) {
            messages.push(message);
            return Promise.resolve({ messageId: `cf_workspace_${messages.length}` });
          },
        },
      });
      initialized = built;
      apiState.value = createApiApp({
        requestId: () => `req_workspace_${crypto.randomUUID()}`,
        getServices: async () => built,
      });
      await built.database.pool.query(
        `INSERT INTO workspace_memberships (id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'viewer')`,
        [
          `membership:${suffix}:browser-viewer`,
          fixture.workspaceId,
          invitedFixture.userId,
        ],
      );
      return built;
    } catch (error) {
      await closeHttpServer(server).catch(() => undefined);
      await vite.close().catch(() => undefined);
      await initialized?.datafn.close().catch(() => undefined);
      await initialized?.email?.close().catch(() => undefined);
      await initialized?.database.close().catch(() => undefined);
      await purgeTenantFixture(databaseUrl, suffix).catch(() => undefined);
      await purgeTenantFixture(databaseUrl, invitedSuffix).catch(() => undefined);
      throw error;
    }
  })();
  let observabilitySeeded = false;

  return {
    csrfToken: fixture.csrfToken,
    email,
    invitedCsrfToken: invitedFixture.csrfToken,
    invitedEmail,
    invitedSessionToken: invitedFixture.sessionToken,
    messages,
    origin,
    sessionToken: fixture.sessionToken,
    skillId: fixture.skillId,
    skillSlug: `pr-review-${suffix}`,
    workspaceId: fixture.workspaceId,
    workspaceSlug: `workspace-${suffix}`,
    async seedObservability() {
      if (observabilitySeeded) return;
      observabilitySeeded = true;
      const versionId = `skill-version:${suffix}`;
      const days = [0, 1, 2].map((offset) => {
        const value = new Date(Date.now() - offset * 86_400_000);
        value.setUTCHours(12, 0, 0, 0);
        return value;
      });
      for (let index = 0; index < 12; index += 1) {
        const occurredAt = new Date((days[index % days.length] as Date).getTime());
        occurredAt.setUTCSeconds(index);
        const outcome = index === 11 ? "denied" : "success";
        await writeAuditEvent(services.database.pool, {
          id: `audit:browser-observability:${String(index).padStart(2, "0")}:${suffix}`,
          workspaceId: fixture.workspaceId,
          eventType: `mcp.skill_retrieve.${outcome}`,
          action: "skill_retrieve",
          outcome,
          actorType: "service_principal",
          actorId: "service-principal:browser-observability",
          requestId: `request:browser-observability:${String(index + 1)}`,
          resourceType: "skill_version",
          resourceId: versionId,
          skillId: fixture.skillId,
          versionId,
          contextId: fixture.contextId,
          caller: {
            agentId: "agent:codex-desktop",
            agentName: "Codex Desktop",
            modelProvider: "openai",
            modelName: "gpt-5.6",
            modelVersion: "2026-07",
            clientName: "skillplane-browser-harness",
            clientVersion: "1.0",
            runId: `run:browser:${String(index + 1)}`,
            sessionId: "session:browser-observability",
            conversationId: "conversation:browser-observability",
          },
          credential: {
            kind: "service_principal",
            id: "service-principal:browser-observability",
          },
          latencyMs: 18 + index,
          ...(outcome === "denied" ? { errorCode: "AUTH_SCOPE_REQUIRED" } : {}),
          channel: "mcp",
          retentionClass: "detailed_read_90d",
          occurredAt,
        });
      }
      const amendmentAt = new Date((days[0] as Date).getTime());
      amendmentAt.setUTCMinutes(1);
      await writeAuditEvent(services.database.pool, {
        id: `audit:browser-observability:amendment:${suffix}`,
        workspaceId: fixture.workspaceId,
        eventType: "skill.amendment.created",
        action: "skills:amend",
        outcome: "success",
        actorType: "service_principal",
        actorId: "service-principal:browser-observability",
        requestId: "request:browser-observability:amendment",
        resourceType: "skill_version",
        resourceId: "skill-version:browser-candidate",
        skillId: fixture.skillId,
        versionId: "skill-version:browser-candidate",
        caller: {
          agentId: "agent:codex-desktop",
          agentName: "Codex Desktop",
          modelProvider: "openai",
          modelName: "gpt-5.6",
          modelVersion: "2026-07",
          clientName: "skillplane-browser-harness",
          clientVersion: "1.0",
          runId: "run:browser:amendment",
          sessionId: "session:browser-observability",
          conversationId: "conversation:browser-observability",
        },
        credential: {
          kind: "service_principal",
          id: "service-principal:browser-observability",
        },
        latencyMs: 36,
        channel: "mcp",
        retentionClass: "permanent",
        occurredAt: amendmentAt,
      });
      for (const value of days) {
        await rollupUtcDay(services.database.pool, {
          day: value.toISOString().slice(0, 10),
          workspaceId: fixture.workspaceId,
        });
      }
    },
    async deleteOAuthClient(clientId) {
      await services.database.pool.query(
        "DELETE FROM authfn_oauth_clients WHERE client_id = $1",
        [clientId],
      );
    },
    async close() {
      await closeHttpServer(server);
      await vite.close();
      await services.datafn.close();
      await services.email?.close();
      await services.database.close();
      await purgeTenantFixture(databaseUrl, suffix);
      await purgeTenantFixture(databaseUrl, invitedSuffix);
    },
  };
}
