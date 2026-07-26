import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSkillBundleFixture,
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { buildApiServices, createApiApp } from "../../../api/src/index.js";

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

export interface LandingBrowserHarness {
  readonly appOrigin: string;
  readonly origin: string;
  readonly privateSkillSlug: string;
  readonly publicSkillId: string;
  readonly publicSearchTerm: string;
  readonly publicSkillSlug: string;
  readonly secondPublicSkillSlug: string;
  readonly workspaceSlug: string;
  close(): Promise<void>;
}

async function toRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const value of request) {
    chunks.push(Buffer.from(value));
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
        reject(new Error("Landing browser harness did not bind a port"));
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

function requestHeaders(
  tenant: TenantFixture,
  idempotencyKey: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    "x-skillplane-workspace-id": tenant.workspaceId,
  };
}

async function jsonData<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(
      `Landing fixture request failed (${response.status}): ${await response.text()}`,
    );
  }
  const envelope = (await response.json()) as { readonly data: T };
  return envelope.data;
}

async function createSkill(
  app: ReturnType<typeof createApiApp>,
  tenant: TenantFixture,
  options: {
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly markdown: string;
    readonly visibility: "private" | "public";
    readonly tags: readonly string[];
  },
): Promise<{
  readonly skill: { readonly id: string };
  readonly version: { readonly id: string };
}> {
  const bundle = await createSkillBundleFixture({
    name: options.name,
    slug: options.slug,
    description: options.description,
    tags: options.tags,
    skillMarkdown: options.markdown,
    files: {
      "references/quality-checklist.md":
        "# Quality checklist\n\n- Verify behavior\n- Inspect authorization\n",
    },
  });
  return jsonData(
    await app.request(`/api/v1/workspaces/${tenant.workspaceId}/skills`, {
      method: "POST",
      headers: requestHeaders(tenant, `landing-create-${options.slug}`),
      body: JSON.stringify({
        bundleBase64: Buffer.from(bundle).toString("base64"),
        visibility: options.visibility,
      }),
    }),
  );
}

async function seedLandingSkills(
  app: ReturnType<typeof createApiApp>,
  tenant: TenantFixture,
  suffix: string,
): Promise<{
  readonly privateSkillSlug: string;
  readonly publicSkillId: string;
  readonly publicSearchTerm: string;
  readonly publicSkillSlug: string;
  readonly secondPublicSkillSlug: string;
}> {
  const shortSuffix = suffix.slice(-12);
  const publicSkillSlug = `public-pr-review-${shortSuffix}`;
  const secondPublicSkillSlug = `incident-triage-${shortSuffix}`;
  const privateSkillSlug = `internal-runbook-${shortSuffix}`;
  const publicSearchTerm = `landingfixture${shortSuffix}`;
  const first = await createSkill(app, tenant, {
    slug: publicSkillSlug,
    name: "Pull request review",
    description: `Review pull requests for correctness, security, maintainability, and focused verification. ${publicSearchTerm}`,
    markdown: `# Pull request review\n\nReview the change as a system, not a diff in isolation. ${publicSearchTerm}\n\n## Priorities\n\n1. Authorization and data boundaries\n2. Correctness and failure behavior\n3. Durable verification\n`,
    visibility: "public",
    tags: ["review", "pull-request", "security"],
  });
  await createSkill(app, tenant, {
    slug: secondPublicSkillSlug,
    name: "Incident triage",
    description:
      "Collect evidence, establish impact, and coordinate a production incident.",
    markdown:
      "# Incident triage\n\nEstablish impact and a reliable timeline before proposing remediation.\n",
    visibility: "public",
    tags: ["incident", "operations"],
  });
  await createSkill(app, tenant, {
    slug: privateSkillSlug,
    name: "Internal production runbook",
    description: "Private operational guidance for the workspace.",
    markdown: "# Internal runbook\n\nPrivate-only escalation contacts.\n",
    visibility: "private",
    tags: ["private"],
  });

  const candidateBundle = await createSkillBundleFixture({
    name: "Pull request review",
    slug: publicSkillSlug,
    description: `Review pull requests for correctness, security, maintainability, and focused verification. ${publicSearchTerm}`,
    tags: ["review", "pull-request", "security"],
    skillMarkdown: `# Pull request review\n\nReview the change as a system, not a diff in isolation. ${publicSearchTerm}\n\n## Priorities\n\n1. Authorization and data boundaries\n2. Correctness and failure behavior\n3. Durable verification\n4. Regression evidence and rollback safety\n`,
    files: {
      "references/quality-checklist.md":
        "# Quality checklist\n\n- Verify behavior\n- Inspect authorization\n- Capture regression evidence\n",
    },
  });
  const candidate = await jsonData<{ version: { readonly id: string } }>(
    await app.request(`/api/v1/skills/${first.skill.id}/versions`, {
      method: "POST",
      headers: requestHeaders(tenant, `landing-candidate-${shortSuffix}`),
      body: JSON.stringify({
        bundleBase64: Buffer.from(candidateBundle).toString("base64"),
        baseVersionId: first.version.id,
        proposedBump: "patch",
        changeSummary: "Add regression evidence and rollback verification",
      }),
    }),
  );
  await jsonData(
    await app.request(
      `/api/v1/skills/${first.skill.id}/candidates/${candidate.version.id}/approve`,
      {
        method: "POST",
        headers: requestHeaders(tenant, `landing-publish-${shortSuffix}`),
      },
    ),
  );
  return {
    privateSkillSlug,
    publicSkillId: first.skill.id,
    publicSearchTerm,
    publicSkillSlug,
    secondPublicSkillSlug,
  };
}

export async function startLandingBrowserHarness(): Promise<LandingBrowserHarness> {
  const databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  const suffix = `landing-browser-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const tenant = await seedTenantFixture(databaseUrl, suffix);
  const services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  const api = createApiApp({
    requestId: () => `req_landing_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
  let apiServer: Server | null = null;
  let landingServer: Server | null = null;
  let vite: ViteDevServer | null = null;
  const originalAppOrigin = process.env.SKILLPLANE_APP_ORIGIN;
  const originalWorkingDirectory = process.cwd();
  try {
    const skills = await seedLandingSkills(api, tenant, suffix);
    const publicProbe = await api.request("/api/v1/skills/public?limit=10");
    if (!publicProbe.ok) {
      throw new Error(
        `Public discovery fixture probe failed (${publicProbe.status}): ${await publicProbe.text()}`,
      );
    }
    apiServer = createHttpServer((incoming, outgoing) => {
      void (async () => {
        await writeResponse(await api.fetch(await toRequest(incoming)), outgoing);
      })().catch(() => {
        outgoing.statusCode = 500;
        outgoing.end("The public API test server failed");
      });
    });
    const apiPort = await listen(apiServer);
    const appOrigin = `http://localhost:${apiPort}`;
    process.env.SKILLPLANE_APP_ORIGIN = appOrigin;

    const landingRoot = resolve(projectRoot, "landing");
    // SvelteKit resolves lazily-loaded SSR route modules from the active project
    // directory, so the browser worker keeps this cwd until the harness closes.
    process.chdir(landingRoot);
    vite = await createViteServer({
      root: landingRoot,
      configFile: resolve(landingRoot, "vite.config.ts"),
      server: { middlewareMode: true, hmr: false },
      appType: "custom",
      logLevel: "error",
    });
    landingServer = createHttpServer((incoming, outgoing) => {
      vite?.middlewares(incoming, outgoing, (middlewareError: unknown) => {
        if (middlewareError) {
          outgoing.statusCode = 500;
          outgoing.end("The landing test application could not be rendered");
        }
      });
    });
    const landingPort = await listen(landingServer);
    return {
      appOrigin,
      origin: `http://localhost:${landingPort}`,
      workspaceSlug: `workspace-${suffix}`,
      ...skills,
      async close() {
        if (landingServer) await closeHttpServer(landingServer);
        if (vite) await vite.close();
        if (apiServer) await closeHttpServer(apiServer);
        if (originalAppOrigin === undefined) {
          delete process.env.SKILLPLANE_APP_ORIGIN;
        } else {
          process.env.SKILLPLANE_APP_ORIGIN = originalAppOrigin;
        }
        process.chdir(originalWorkingDirectory);
        await services.datafn.close();
        await services.email?.close();
        await services.database.close();
        await purgeTenantFixture(databaseUrl, suffix);
      },
    };
  } catch (error) {
    if (landingServer) await closeHttpServer(landingServer).catch(() => undefined);
    if (vite) await vite.close().catch(() => undefined);
    if (apiServer) await closeHttpServer(apiServer).catch(() => undefined);
    if (originalAppOrigin === undefined) {
      delete process.env.SKILLPLANE_APP_ORIGIN;
    } else {
      process.env.SKILLPLANE_APP_ORIGIN = originalAppOrigin;
    }
    process.chdir(originalWorkingDirectory);
    await services.datafn.close().catch(() => undefined);
    await services.email?.close().catch(() => undefined);
    await services.database.close().catch(() => undefined);
    await purgeTenantFixture(databaseUrl, suffix).catch(() => undefined);
    throw error;
  }
}
