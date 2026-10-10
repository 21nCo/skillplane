import { randomUUID } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPostgresOtpRateLimiter,
  createSkillplaneAuthServer,
} from "@skillplane/auth";
import {
  createDatabaseClient,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "@skillplane/db";
import { createSkillplaneSendFn, type CloudflareEmailMessage } from "@skillplane/email";
import { createServer as createViteServer, type ViteDevServer } from "vite";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface AuthBrowserHarness {
  readonly code: string;
  readonly email: string;
  readonly messages: CloudflareEmailMessage[];
  readonly origin: string;
  close(): Promise<void>;
}

async function toRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk: unknown = value;
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    } else {
      throw new Error("The request body contained an unsupported chunk");
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
  const host = request.headers.host ?? "localhost";
  const method = request.method ?? "GET";
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method,
    headers,
    ...(["GET", "HEAD"].includes(method) ? {} : { body: Buffer.concat(chunks) }),
  });
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
        reject(new Error("Auth browser harness did not bind a TCP port"));
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

export async function startAuthBrowserHarness(): Promise<AuthBrowserHarness> {
  const databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  const database = createDatabaseClient({
    connectionString: databaseUrl,
    applicationName: "skillplane-auth-browser-test",
    maxConnections: 4,
  });
  const suffix = randomUUID().replaceAll("-", "");
  const email = `browser-${suffix}@auth.skillplane.test`;
  const code = "123456";
  const messages: CloudflareEmailMessage[] = [];
  const sendfn = createSkillplaneSendFn({
    from: "Skillplane <no-reply@auth.skillplane.dev>",
    environment: "production",
    signInUrl: "https://app.skillplane.dev",
    binding: {
      send(message) {
        messages.push(message);
        return Promise.resolve({
          messageId: `cf_browser_${String(messages.length)}`,
        });
      },
    },
  });
  const auth = createSkillplaneAuthServer({
    database,
    oauth: {
      issuer: "https://app.skillplane.dev",
      resource: "https://mcp.skillplane.dev/mcp",
      tokenPepper: "browser-test-oauth-token-pepper-32-characters",
    },
    delivery: sendfn.delivery,
    codeGenerator: () => code,
    rateLimiter: createPostgresOtpRateLimiter({
      pool: database.pool,
      pepper: "auth-browser-rate-limit-pepper-32-characters",
      recipientLimit: 2,
      networkLimit: 20,
      windowSeconds: 900,
    }),
    turnstile: {
      verify: ({ token }) =>
        Promise.resolve(
          token === "turnstile-pass"
            ? { success: true, reason: "verified" }
            : { success: false, reason: "invalid" },
        ),
    },
    emit: () => undefined,
  });

  process.env.PUBLIC_TURNSTILE_SITE_KEY = "e2e-site-key";
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
  const server = createHttpServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.url?.startsWith("/auth/")) {
        const request = await toRequest(incoming);
        await writeResponse(await auth.handle(request), outgoing);
        return;
      }
      vite.middlewares(incoming, outgoing, (error: unknown) => {
        if (error) {
          outgoing.statusCode = 500;
          outgoing.end("The test application could not be rendered");
        }
      });
    })().catch(() => {
      outgoing.statusCode = 500;
      outgoing.end("The test application could not be served");
    });
  });
  const port = await listen(server);

  return {
    code,
    email,
    messages,
    origin: `http://localhost:${String(port)}`,
    async close() {
      await closeHttpServer(server);
      await vite.close();
      await database.pool.query("DELETE FROM authfn_otp_challenges WHERE email = $1", [
        email,
      ]);
      await database.pool.query("DELETE FROM authfn_users WHERE primary_email = $1", [
        email,
      ]);
      await sendfn.close();
      await database.close();
    },
  };
}
