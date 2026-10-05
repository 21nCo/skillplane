import { runAuthenticatedOfficialConformance } from "@mcpfn/testing";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startMcpTestEnvironment,
  type McpTestEnvironment,
} from "../support/mcp-test-environment.js";

let environment: McpTestEnvironment;
let server: Server;
let endpoint: string;

async function webRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? "GET";
  return new Request(`http://${request.headers.host}${request.url ?? "/"}`, {
    method,
    headers,
    ...(["GET", "HEAD"].includes(method) ? {} : { body: Buffer.concat(chunks) }),
  });
}

async function writeWebResponse(
  response: Response,
  target: ServerResponse,
): Promise<void> {
  target.statusCode = response.status;
  for (const [name, value] of response.headers) target.setHeader(name, value);
  target.end(Buffer.from(await response.arrayBuffer()));
}

function closeServer(value: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    value.close((error) => (error ? reject(error) : resolveClose()));
  });
}

interface ConformanceCheck {
  id: string;
  status: string;
}

const CHECK_ID_BY_SCENARIO: Readonly<Record<string, string>> = {
  "server-sse-multiple-streams": "server-sse-multiple-streams-session",
  "elicitation-sep1034-defaults": "elicitation-sep1034-general",
  "elicitation-sep1330-enums": "elicitation-sep1330-general",
};

function conformanceChecks(stdout: string): ConformanceCheck[] {
  const arrays = [...stdout.matchAll(/^\[\r?\n[\s\S]*?^\]/gmu)];
  expect(arrays).toHaveLength(1);
  const parsed: unknown = JSON.parse(arrays[0]?.[0] ?? "null");
  expect(Array.isArray(parsed)).toBe(true);
  const checks = parsed as ConformanceCheck[];
  expect(checks.length).toBeGreaterThan(0);
  for (const check of checks) {
    expect(typeof check.id).toBe("string");
    expect(["SUCCESS", "FAILURE", "WARNING", "INFO"]).toContain(check.status);
  }
  return checks;
}

beforeAll(async () => {
  environment = await startMcpTestEnvironment("official-conformance");
  server = createServer((request, response) => {
    void webRequest(request)
      .then((converted) => environment.app.fetch(converted))
      .then((result) => writeWebResponse(result, response))
      .catch((error: unknown) => {
        const details =
          error instanceof Error ? (error.stack ?? error.message) : String(error);
        process.stderr.write(`Official conformance forwarding failed: ${details}\n`);
        response.writeHead(500).end();
      });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Official conformance target did not bind a TCP port");
  }
  endpoint = `http://127.0.0.1:${address.port}/mcp`;
}, 60_000);

afterAll(async () => {
  await closeServer(server);
  await environment.close();
}, 30_000);

describe("official MCP server conformance", () => {
  it("passes the pinned active suite through authenticated Streamable HTTP", async () => {
    const verificationDir = resolve(
      process.cwd(),
      "..",
      ".conduct",
      "verification",
      "SKI-6",
    );
    const expectedFailures = resolve(
      process.cwd(),
      "tests",
      "conformance",
      "expected-failures.yml",
    );
    const result = await runAuthenticatedOfficialConformance({
      url: endpoint,
      headers: { authorization: `Bearer ${environment.serviceToken}` },
      suite: "active",
      expectedFailures,
      stdio: "pipe",
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`.slice(-8_000)).toBe(0);
    const scenarios = [
      ...result.stdout.matchAll(/^=== Running scenario: (.+) ===$/gmu),
    ].map((match) => match[1] ?? "");
    expect(scenarios.length).toBeGreaterThan(0);
    expect(scenarios).not.toContain("");
    expect(new Set(scenarios).size).toBe(scenarios.length);
    // The pinned runner emits check details only for individual scenarios.
    // Its suite run still verifies the complete active catalog and baseline.
    const scenarioResults = [];
    for (let index = 0; index < scenarios.length; index += 4) {
      scenarioResults.push(
        ...(await Promise.all(
          scenarios.slice(index, index + 4).map((scenario) =>
            runAuthenticatedOfficialConformance({
              url: endpoint,
              headers: { authorization: `Bearer ${environment.serviceToken}` },
              scenario,
              expectedFailures,
              verbose: true,
              stdio: "pipe",
            }),
          ),
        )),
      );
    }
    const capturedResults = [result, ...scenarioResults];
    const capturedContents = capturedResults.flatMap(({ stdout, stderr }) => [
      stdout,
      stderr,
    ]);
    const capturedBytes = capturedContents.reduce(
      (sum, value) => sum + Buffer.byteLength(value),
      0,
    );
    expect(capturedBytes).toBeLessThan(1_000_000);
    for (const scenarioResult of scenarioResults) {
      expect(
        scenarioResult.exitCode,
        `${scenarioResult.stdout}\n${scenarioResult.stderr}`.slice(-8_000),
      ).toBe(0);
    }
    const checks = scenarioResults.flatMap(({ stdout }) => conformanceChecks(stdout));
    const statusCounts = checks.reduce<Record<string, number>>((counts, check) => {
      counts[check.status] = (counts[check.status] ?? 0) + 1;
      return counts;
    }, {});
    const secretMaterialDetected = capturedContents.some((contents) =>
      contents.includes(environment.serviceToken),
    );
    const expectedFailureScenarios = (await readFile(expectedFailures, "utf8"))
      .split("\n")
      .map((line) => /^\s+-\s+(.+)$/u.exec(line)?.[1])
      .filter((value): value is string => Boolean(value));
    const expectedNonSuccessCheckIds = expectedFailureScenarios
      .map((scenario) => CHECK_ID_BY_SCENARIO[scenario] ?? scenario)
      .toSorted();
    const nonSuccessCheckIds = checks
      .filter((check) => check.status !== "SUCCESS")
      .map((check) => check.id)
      .toSorted();

    expect(secretMaterialDetected).toBe(false);
    expect(nonSuccessCheckIds).toEqual(expectedNonSuccessCheckIds);

    await mkdir(verificationDir, { recursive: true });
    const summaryPath = join(verificationDir, "official-conformance-summary.json");
    const summary = {
      schemaVersion: 3,
      runner: "@modelcontextprotocol/conformance@0.1.16",
      suite: "active",
      authenticated: true,
      interpretation:
        "Exit code zero validates the executable scenario baseline, while exact non-success check-id equality validates the runner's emitted failure and warning evidence; initialization, ping, tool inventory, request handling, and DNS-rebinding checks remain hard gates.",
      expectedFailureScenarios,
      expectedNonSuccessCheckIds,
      result: {
        exitCode: result.exitCode,
        checks: checks.map(({ id, status }) => ({ id, status })),
        statusCounts,
      },
      artifactHygiene: {
        redactedOutputBytes: capturedBytes,
        retainedRawArtifacts: false,
        secretMaterialDetected,
      },
    };
    let completedAt = new Date().toISOString();
    try {
      const existing = JSON.parse(await readFile(summaryPath, "utf8")) as Record<
        string,
        unknown
      >;
      const { completedAt: existingCompletedAt, ...existingSummary } = existing;
      if (
        typeof existingCompletedAt === "string" &&
        JSON.stringify(existingSummary) === JSON.stringify(summary)
      ) {
        completedAt = existingCompletedAt;
      }
    } catch {
      // A missing or invalid prior summary is replaced with current evidence.
    }
    await writeFile(
      summaryPath,
      `${JSON.stringify(
        {
          ...summary,
          completedAt,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }, 180_000);
});
