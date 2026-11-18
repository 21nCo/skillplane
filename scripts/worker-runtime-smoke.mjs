#!/usr/bin/env node
// Runs the built app Worker, the public GitHub source provider and GitHub App
// authentication (RS256 App JWT via Web Crypto, installation token) in workerd.
// Node tests cannot catch Worker-only failures: a bundled dependency that
// requires a Node builtin at module load, fetch called with another receiver,
// or a RequestInit value that workerd rejects. Requires a built app
// (`pnpm build` or `pnpm deploy:check`).
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = `${root}app/`;
// Use the miniflare and esbuild versions that ship with the deploying wrangler.
const fromWrangler = createRequire(createRequire(import.meta.url).resolve("wrangler"));
const { Miniflare } = await import(fromWrangler.resolve("miniflare"));
const esbuild = await import(fromWrangler.resolve("esbuild"));

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? "ok" : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

const database = process.env.SKILLPLANE_SMOKE_DATABASE_URL;

async function appWorker() {
  if (!existsSync(`${app}.svelte-kit/cloudflare/_worker.js`))
    throw new Error("Build the app before running the Worker smoke test");
  const worker = await unstable_startWorker({
    config: `${app}wrangler.jsonc`,
    build: { bundle: true },
    // Local runtime settings. Without SKILLPLANE_SMOKE_DATABASE_URL no database
    // is reachable: routes that need one must still answer as handled errors.
    bindings: Object.fromEntries(
      Object.entries({
        RUNTIME_ENV: "local",
        DATABASE_ADAPTER: "postgres",
        DATABASE_URL: database ?? "postgres://smoke:smoke@127.0.0.1:9/skillplane",
        AUTH_MODE: "disabled",
      }).map(([name, value]) => [name, { type: "plain_text", value }]),
    ),
    dev: {
      server: { hostname: "127.0.0.1", port: 0 },
      inspector: false,
      persist: false,
      watch: false,
      logLevel: "error",
    },
  });
  try {
    await worker.ready;
    // A Worker that fails at module load or throws past the app answers with
    // workerd's plain "Internal Error" (Cloudflare 1101), never an app envelope.
    const handled = (status, body) =>
      status === 200 ||
      (database === undefined && status >= 500 && /"code":"[A-Z_]+"/.test(body));
    for (const [path, accepted] of [
      ["/auth/session", handled],
      ["/api/v1/workspaces", (status) => status === 401],
    ]) {
      const response = await worker.fetch(`http://localhost${path}`, {
        redirect: "manual",
      });
      const body = await response.text();
      check(
        accepted(response.status, body),
        `app Worker GET ${path} -> ${response.status}${response.status >= 500 ? `: ${body.slice(0, 300)}` : ""}`,
      );
    }
  } finally {
    await worker.dispose();
  }
}

function blobSha(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

async function providerSnapshot() {
  const commit = "c".repeat(40),
    tree = "d".repeat(40);
  const skill = Buffer.from(
    "---\nname: Smoke Review\ndescription: Worker runtime smoke skill\n---\n# Review\n",
  );
  const redirected = Buffer.from("redirected\n");
  const blobs = new Map([
    [blobSha(skill), skill],
    [blobSha(redirected), redirected],
  ]);
  const requested = [];
  const github = (request) => {
    const url = new URL(request.url);
    requested.push(url.href);
    if (url.hostname !== "api.github.com")
      return new Response("unexpected host", { status: 599 });
    const path = url.pathname;
    if (/\/commits\/main$/.test(path)) return new Response(commit);
    if (path.endsWith(`/git/commits/${commit}`))
      return Response.json({ sha: commit, tree: { sha: tree } });
    if (path.endsWith(`/git/trees/${tree}`))
      return Response.json({
        truncated: false,
        tree: [...blobs].map(([sha, bytes], index) => ({
          path: index === 0 ? "skills/review/SKILL.md" : "skills/moved/SKILL.md",
          mode: "100644",
          type: "blob",
          sha,
          size: bytes.length,
        })),
      });
    const blob = /\/git\/blobs\/([a-f0-9]{40})$/.exec(path)?.[1];
    // A redirected content request must be rejected, never followed.
    if (blob === blobSha(redirected))
      return new Response(null, {
        status: 302,
        headers: { location: "https://redirect.invalid/blob" },
      });
    if (blob && blobs.has(blob))
      return Response.json({
        sha: blob,
        encoding: "base64",
        content: blobs.get(blob).toString("base64"),
      });
    return new Response("not found", { status: 404 });
  };
  const entry = `
    import { PublicGitHubSourceProvider, gitSourceConfig } from ${JSON.stringify(`${root}packages/domain/src/git-source-provider.ts`)};
    const run = async (path) => {
      try {
        const snapshot = await new PublicGitHubSourceProvider().snapshot(
          gitSourceConfig({ repositoryUrl: "https://github.com/acme/skills", ref: "main", path }),
        );
        return { commitSha: snapshot.commitSha, skills: snapshot.skills.map((s) => ({ path: s.path, slug: s.bundle?.skill.slug ?? null, digest: s.bundle?.digest ?? null, error: s.error })) };
      } catch (error) {
        return { error: { code: error.code ?? null, status: error.status ?? null, message: String(error.message) } };
      }
    };
    export default {
      async fetch() {
        return Response.json({ scoped: await run("skills/review"), redirected: await run("skills/moved") });
      },
    };`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*"],
    logLevel: "error",
  });
  const mf = new Miniflare({
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: "2026-05-03",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: github,
  });
  try {
    const result = await (await mf.dispatchFetch("http://localhost/")).json();
    check(
      result.scoped?.commitSha === commit &&
        result.scoped.skills?.length === 1 &&
        result.scoped.skills[0].slug === "smoke-review" &&
        result.scoped.skills[0].error === null,
      `provider snapshot in workerd with the default fetch -> ${JSON.stringify(result.scoped)}`,
    );
    check(
      result.redirected?.error?.status === 503 &&
        /redirected/.test(result.redirected.error.message) &&
        !requested.some((url) => url.startsWith("https://redirect.invalid")),
      `provider rejects a redirected blob without following it -> ${JSON.stringify(result.redirected)}`,
    );
  } finally {
    await mf.dispose();
  }
}

async function githubAppSnapshot() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  // GitHub issues App keys as PKCS#1, which Web Crypto cannot import directly.
  const privateKeyPem = keys.privateKey.export({ type: "pkcs1", format: "pem" });
  const token = `ghs_${"s".repeat(36)}`;
  const commit = "e".repeat(40),
    tree = "f".repeat(40);
  const skill = Buffer.from(
    "---\nname: Private Smoke\ndescription: Worker App smoke skill\n---\n# Private\n",
  );
  const minted = [];
  const github = async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "api.github.com")
      return new Response("unexpected host", { status: 599 });
    if (url.pathname === "/app/installations/9/access_tokens") {
      const jwt = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const [header = "", payload = "", signature = ""] = jwt.split(".");
      const valid = verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        keys.publicKey,
        Buffer.from(signature, "base64url"),
      );
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      minted.push({ valid, iss: claims.iss, body: await request.json() });
      if (!valid) return new Response("bad jwt", { status: 401 });
      return Response.json({
        token,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: { contents: "read", metadata: "read" },
        repositories: [{ name: "private", full_name: "acme/private" }],
      });
    }
    // The private repository is invisible without the installation token.
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response("not found", { status: 404 });
    const path = url.pathname;
    if (/\/commits\/main$/.test(path)) return new Response(commit);
    if (path.endsWith(`/git/commits/${commit}`))
      return Response.json({ sha: commit, tree: { sha: tree } });
    if (path.endsWith(`/git/trees/${tree}`))
      return Response.json({
        truncated: false,
        tree: [
          {
            path: "SKILL.md",
            mode: "100644",
            type: "blob",
            sha: blobSha(skill),
            size: skill.length,
          },
        ],
      });
    if (path.endsWith(`/git/blobs/${blobSha(skill)}`))
      return Response.json({
        sha: blobSha(skill),
        encoding: "base64",
        content: skill.toString("base64"),
      });
    return new Response("not found", { status: 404 });
  };
  const entry = `
    import { AuthenticatedGitHubSourceProvider, gitSourceConfig } from ${JSON.stringify(`${root}packages/domain/src/git-source-provider.ts`)};
    import { GitHubApp } from ${JSON.stringify(`${root}packages/domain/src/github-app.ts`)};
    export default {
      async fetch(request, env) {
        try {
          const app = new GitHubApp({ appId: "4242", privateKeyPem: env.GITHUB_APP_PRIVATE_KEY });
          const snapshot = await new AuthenticatedGitHubSourceProvider(app, 9).snapshot(
            gitSourceConfig({ repositoryUrl: "https://github.com/acme/private", ref: "main" }),
          );
          return Response.json({ commitSha: snapshot.commitSha, skills: snapshot.skills.map((s) => ({ slug: s.bundle?.skill.slug ?? null, error: s.error })) });
        } catch (error) {
          return Response.json({ error: { code: error.code ?? null, message: String(error.message) } });
        }
      },
    };`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*"],
    logLevel: "error",
  });
  const mf = new Miniflare({
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: "2026-05-03",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { GITHUB_APP_PRIVATE_KEY: privateKeyPem },
    outboundService: github,
  });
  try {
    const result = await (await mf.dispatchFetch("http://localhost/")).json();
    check(
      minted.length === 1 &&
        minted[0].valid &&
        minted[0].iss === "4242" &&
        JSON.stringify(minted[0].body) ===
          JSON.stringify({
            repositories: ["private"],
            permissions: { contents: "read" },
          }),
      `GitHub App JWT signed in workerd verifies and requests a read token for one repository -> ${JSON.stringify(minted.map(({ valid, iss, body }) => ({ valid, iss, body })))}`,
    );
    check(
      result.commitSha === commit &&
        result.skills?.length === 1 &&
        result.skills[0].slug === "private-smoke" &&
        result.skills[0].error === null,
      `authenticated provider snapshot in workerd -> ${JSON.stringify(result)}`,
    );
  } finally {
    await mf.dispose();
  }
}

for (const [name, run] of [
  ["app Worker", appWorker],
  ["provider snapshot", providerSnapshot],
  ["GitHub App snapshot", githubAppSnapshot],
])
  await run().catch((error) => check(false, `${name} failed in workerd: ${error}`));
if (failures.length) {
  console.error(`Worker runtime smoke failed: ${failures.length} check(s)`);
  process.exit(1);
}
console.log("Worker runtime smoke passed");
