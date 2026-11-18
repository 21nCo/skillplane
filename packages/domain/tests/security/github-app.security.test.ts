import { inspect } from "node:util";
import { redactAuditMetadata } from "@skillplane/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError } from "../../src/errors.js";
import {
  AuthenticatedGitHubSourceProvider,
  gitSourceConfig,
} from "../../src/git-source-provider.js";
import { GitHubApp } from "../../src/github-app.js";
import { appPrivateKeyPem, startFakeGitHub, type FakeGitHub } from "../fake-github.js";

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
