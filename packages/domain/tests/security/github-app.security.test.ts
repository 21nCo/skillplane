import { inspect } from "node:util";
import { redactAuditMetadata } from "@skillplane/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/errors.js";
import {
  AuthenticatedGitHubSourceProvider,
  gitSourceConfig,
} from "../../src/git-source-provider.js";
import { GitHubApp } from "../../src/github-app.js";
import { GitSourceService } from "../../src/git-sources.js";
import { IdempotencyStore } from "../../src/idempotency.js";
import type { Principal } from "../../src/principal.js";
import { SkillService } from "../../src/skills.js";
import { SkillVersionService } from "../../src/skill-versions.js";
import { appPrivateKeyPem, startFakeGitHub, type FakeGitHub } from "../fake-github.js";
import { Pool } from "pg";
import { R2BundleRepository } from "@skillplane/storage";
import { migrateDatabase } from "../../../db/src/migrate.js";
import { resolveTestDatabaseUrl } from "../../../db/src/database-url.js";
import { seedTenantFixture } from "../../../testing/src/fixtures.js";
import { TestObjectStorage } from "../../../testing/src/runtime.js";

// Installation tokens and the App private key must never reach a log line, an
// error (message, details or stack), an API error body or an audit row, even
// when GitHub echoes them back.

const keyBody = appPrivateKeyPem
  .split("\n")
  .filter((line) => line && !line.startsWith("-----"));
let github: FakeGitHub | null = null;
const logged: string[] = [];

beforeEach(() => {
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((arg) => inspect(arg, { depth: 8 })).join(" "));
    });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await github?.close();
  github = null;
});

function surfaces(error: unknown): string[] {
  const domain = error instanceof DomainError ? error : null;
  // toApiError returns exactly code, message and details of a DomainError;
  // audit rows store metadata after redactAuditMetadata.
  return [
    String(error),
    error instanceof Error ? (error.stack ?? "") : "",
    inspect(error, { depth: 8 }),
    JSON.stringify(
      domain
        ? { code: domain.code, message: domain.message, details: domain.details }
        : {},
    ),
    JSON.stringify(
      redactAuditMetadata({
        errorCode: domain?.code ?? null,
        errorMessage: domain?.message ?? String(error),
        details: domain?.details ?? null,
      }).value,
    ),
  ];
}

function expectNoSecrets(texts: string[], tokens: string[]) {
  const joined = texts.join("\n");
  for (const token of tokens) expect(joined).not.toContain(token);
  expect(joined).not.toMatch(/ghs_[A-Za-z0-9]{20,}/u);
  expect(joined).not.toContain("PRIVATE KEY");
  for (const line of keyBody.slice(1, 4)) expect(joined).not.toContain(line);
}

describe("GitHub App secret handling", () => {
  it("keeps tokens and the private key out of errors, logs, audit and API bodies", async () => {
    github = await startFakeGitHub({
      "skills/review/SKILL.md": "---\nname: R\ndescription: D\n---\n# R\n",
    });
    // A wrapping fetcher that makes GitHub echo the bearer token in failures.
    let echo = false;
    const fetcher: typeof fetch = async (input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      if (echo && !String(input).includes("/access_tokens"))
        return new Response(JSON.stringify({ message: `bad ${authorization}` }), {
          status: 500,
        });
      return fetch(input, init);
    };
    const app = new GitHubApp(
      { appId: "123456", privateKeyPem: appPrivateKeyPem },
      { apiBaseUrl: github.baseUrl, fetcher },
    );
    const provider = new AuthenticatedGitHubSourceProvider(app, github.installationId);
    const repositoryUrl = `https://github.com/${github.repository}`;
    const config = gitSourceConfig({ repositoryUrl, ref: "main" });
    await provider.snapshot(config);
    await provider.createBlob(repositoryUrl, new TextEncoder().encode("x"));
    const errors: unknown[] = [];
    echo = true;
    errors.push(await provider.snapshot(config).catch((e: unknown) => e));
    errors.push(
      await provider
        .createBlob(repositoryUrl, new TextEncoder().encode("y"))
        .catch((e: unknown) => e),
    );
    echo = false;
    github.revoke();
    errors.push(await provider.snapshot(config).catch((e: unknown) => e));
    errors.push(
      await new GitHubApp(
        {
          appId: "1",
          privateKeyPem: appPrivateKeyPem.replace(/[A-Za-z]{8}\n/u, "!\n"),
        },
        { apiBaseUrl: github.baseUrl },
      )
        .installationToken({
          installationId: 1,
          repositories: [github.repository],
          access: "read",
        })
        .catch((e: unknown) => e),
    );
    const tokens = [...github.tokens.keys()];
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    expect(errors.map((e) => (e as DomainError).code)).toEqual([
      "SERVICE_UNAVAILABLE",
      "SERVICE_UNAVAILABLE",
      "GIT_SOURCE_AUTH_FAILED",
      "SERVICE_UNAVAILABLE",
    ]);
    expectNoSecrets([...errors.flatMap(surfaces), ...logged], tokens);
    // Neither a serialized nor an inspected App or provider exposes them.
    expectNoSecrets(
      [
        JSON.stringify(app),
        inspect(app, { depth: 8 }),
        JSON.stringify(provider),
        inspect(provider, { depth: 8 }),
      ],
      tokens,
    );
  });
});

describe("GitHub App source auth_failed marker", () => {
  it("records revoked access without a token, JWT or key in audit or run rows", async () => {
    github = await startFakeGitHub({
      "skills/review/SKILL.md": "---\nname: R\ndescription: D\n---\n# R\n",
    });
    // GitHub echoes every bearer it receives (App JWT or installation token)
    // in its failure bodies.
    const bearers = new Set<string>();
    const fetcher: typeof fetch = async (input, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      if (authorization) bearers.add(authorization.replace(/^\S+\s+/u, ""));
      const response = await fetch(input, init);
      if (response.ok) return response;
      return new Response(JSON.stringify({ message: `refused ${authorization}` }), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    };
    const app = new GitHubApp(
      { appId: "123456", privateKeyPem: appPrivateKeyPem },
      { apiBaseUrl: github.baseUrl, fetcher },
    );
    const url = await resolveTestDatabaseUrl();
    await migrateDatabase(url);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      const storage = new R2BundleRepository(new TestObjectStorage());
      const skills = new SkillService(pool, storage);
      const sources = new GitSourceService(
        pool,
        skills,
        new SkillVersionService(pool, storage, new IdempotencyStore(pool)),
        new AuthenticatedGitHubSourceProvider(app, github.installationId),
      );
      const tenant = await seedTenantFixture(url, `gh-sec-${crypto.randomUUID()}`);
      const owner: Principal = {
        kind: "user",
        role: "owner",
        actorId: tenant.userId,
        userId: tenant.userId,
        sessionId: "s",
        workspaceId: tenant.workspaceId,
      };
      const m = () => ({
        principal: owner,
        requestId: crypto.randomUUID(),
        fencingEpoch: 1,
      });
      const source = await sources.create({
        ...m(),
        config: {
          repositoryUrl: `https://github.com/${github.repository}`,
          ref: "main",
        },
        idempotencyKey: crypto.randomUUID(),
      });
      const run = await sources.preview({ ...m(), sourceId: source.id });
      github.revoke();
      const errors = [
        await sources.preview({ ...m(), sourceId: source.id }).catch((e: unknown) => e),
        await sources
          .apply({ ...m(), sourceId: source.id, runId: run.id })
          .catch((e: unknown) => e),
      ];
      expect(errors.map((e) => (e as DomainError).code)).toEqual([
        "GIT_SOURCE_AUTH_FAILED",
        "GIT_SOURCE_AUTH_FAILED",
      ]);
      const audit = await pool.query<{ event_type: string; metadata: unknown }>(
        "SELECT * FROM audit_events WHERE workspace_id=$1 ORDER BY occurred_at,id",
        [owner.workspaceId],
      );
      expect(
        audit.rows.filter((row) => row.event_type === "skill_source.auth_failed"),
      ).toHaveLength(2);
      const runs = await pool.query(
        "SELECT * FROM skill_source_runs WHERE workspace_id=$1",
        [owner.workspaceId],
      );
      const sourceRows = await pool.query(
        "SELECT * FROM skill_sources WHERE workspace_id=$1",
        [owner.workspaceId],
      );
      const tokens = [...github.tokens.keys(), ...bearers];
      expect(github.tokens.size).toBeGreaterThanOrEqual(1);
      expectNoSecrets(
        [
          ...errors.flatMap(surfaces),
          ...logged,
          JSON.stringify(audit.rows),
          JSON.stringify(runs.rows),
          JSON.stringify(sourceRows.rows),
        ],
        tokens,
      );
    } finally {
      await pool.end();
    }
  });
});
