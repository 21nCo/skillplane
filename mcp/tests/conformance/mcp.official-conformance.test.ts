import { runAuthenticatedOfficialConformance } from "@mcpfn/testing";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
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

async function collectArtifactFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectArtifactFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
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
    const outputDir = await mkdtemp(join(tmpdir(), "skillplane-mcp-conformance-"));
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
    try {
      const result = await runAuthenticatedOfficialConformance({
        url: endpoint,
        headers: { authorization: `Bearer ${environment.serviceToken}` },
        suite: "active",
        expectedFailures,
        outputDir,
        stdio: "pipe",
      });
      const artifactFiles = await collectArtifactFiles(outputDir);
      const artifactBytes = (
        await Promise.all(artifactFiles.map(async (path) => (await stat(path)).size))
      ).reduce((sum, size) => sum + size, 0);
      expect(artifactBytes).toBeLessThan(1_000_000);
      const artifactContents = await Promise.all(
        artifactFiles.map(async (path) => await readFile(path, "utf8")),
      );
      const checks = artifactContents.flatMap((contents) => {
        try {
          const parsed = JSON.parse(contents) as unknown;
          if (!Array.isArray(parsed)) return [];
          return parsed.filter(
            (value): value is ConformanceCheck =>
              typeof value === "object" &&
              value !== null &&
              typeof (value as ConformanceCheck).id === "string" &&
              typeof (value as ConformanceCheck).status === "string",
          );
        } catch {
          return [];
        }
      });
      const statusCounts = checks.reduce<Record<string, number>>((counts, check) => {
        counts[check.status] = (counts[check.status] ?? 0) + 1;
        return counts;
      }, {});
      const secretMaterialDetected = artifactContents.some((contents) =>
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
        schemaVersion: 2,
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
          rawArtifactBytes: artifactBytes,
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
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`.slice(-8_000)).toBe(
        0,
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  }, 180_000);
});
