import { env as publicEnv } from "$env/dynamic/public";
import { csrfToken } from "$lib/api/client.js";
import {
  createDatafnHttpRouteProvider,
  createSkillplaneDatafnClient,
  type SkillplaneDatafnClient,
} from "@skillplane/datafn/client";

export class SkillplaneDatafnReadError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SkillplaneDatafnReadError";
    this.code = code;
  }
}

const browserClients = new Map<string, SkillplaneDatafnClient>();
const canonicalUntil = new Map<string, number>();

function datafnError(cause: unknown): Error {
  if (cause instanceof Error) return cause;
  if (cause && typeof cause === "object") {
    const record = cause as { readonly code?: unknown; readonly message?: unknown };
    if (typeof record.message === "string") {
      return new SkillplaneDatafnReadError(
        typeof record.code === "string" ? record.code : "DATAFN_QUERY_FAILED",
        record.message,
      );
    }
  }
  return new SkillplaneDatafnReadError(
    "DATAFN_QUERY_FAILED",
    "Skillplane could not load workspace data",
  );
}

function routeFailure(cause: unknown): boolean {
  const error = datafnError(cause) as Error & { code?: string };
  return (
    error.code?.startsWith("DATAFN_ROUTE_") === true ||
    [
      "DATAFN_REGION_MISMATCH",
      "DATAFN_NAMESPACE_MOVING",
      "DATAFN_REGIONAL_ENDPOINT_UNAVAILABLE",
      "DATAFN_PLACEMENT_UNAVAILABLE",
      "AUTHENTICATION_REQUIRED",
    ].includes(error.code ?? "") ||
    /^HTTP Error (?:404|503):/u.test(error.message)
  );
}

function report(
  phase: "bootstrap" | "datafn" | "total",
  route: "gateway" | "regional",
  started: number,
  status: number,
) {
  console.info(
    JSON.stringify({
      event: "datafn.transport",
      phase,
      route,
      status,
      durationMs: Math.round(performance.now() - started),
    }),
  );
}

function createCanonicalClient(workspaceId: string): SkillplaneDatafnClient {
  return createSkillplaneDatafnClient({
    clientId: `skillplane-app:${workspaceId}`,
    namespace: workspaceId,
    remote: "/datafn",
    http: {
      credentials: "include",
      headers: { "x-skillplane-workspace-id": workspaceId },
    },
  });
}

function createRegionalClient(workspaceId: string): SkillplaneDatafnClient {
  const bootstrap = createDatafnHttpRouteProvider({
    bootstrapUrl: new URL("/api/v1/datafn/route", window.location.origin).href,
    credentials: "include",
    headers: () => {
      const token = csrfToken();
      return {
        "x-skillplane-workspace-id": workspaceId,
        ...(token ? { "x-authfn-csrf": token } : {}),
      };
    },
    fetch: async (input, init) => {
      const started = performance.now();
      const response = await fetch(input, init);
      report("bootstrap", "gateway", started, response.status);
      return response;
    },
  });
  return createSkillplaneDatafnClient({
    clientId: `skillplane-app:${workspaceId}`,
    namespace: workspaceId,
    remote: "/datafn",
    routeProvider: bootstrap,
    http: {
      credentials: "omit",
      headers: { "x-skillplane-workspace-id": workspaceId },
      fetch: async (input, init) => {
        const started = performance.now();
        const inputUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const route =
          new URL(inputUrl, window.location.origin).origin === window.location.origin
            ? "gateway"
            : "regional";
        const response = await fetch(input, init);
        report("datafn", route, started, response.status);
        return response;
      },
    },
  });
}

export async function resetWorkspaceDatafnClients(): Promise<void> {
  const clients = [...browserClients.values()];
  browserClients.clear();
  canonicalUntil.clear();
  await Promise.all(clients.map((client) => client.destroy()));
}

/** Only first-party reads use this boundary, so a failed regional read can be retried canonically. */
export async function withWorkspaceDatafnReadClient<T>(
  workspaceId: string,
  operation: (client: SkillplaneDatafnClient) => Promise<T>,
): Promise<T> {
  const direct =
    typeof window !== "undefined" &&
    publicEnv.PUBLIC_DATAFN_DIRECT_ENABLED === "true" &&
    (canonicalUntil.get(workspaceId) ?? 0) <= Date.now();
  const started = performance.now();
  const client = direct
    ? (browserClients.get(workspaceId) ?? createRegionalClient(workspaceId))
    : createCanonicalClient(workspaceId);
  if (direct && !browserClients.has(workspaceId))
    browserClients.set(workspaceId, client);
  try {
    const result = await operation(client);
    report("total", direct ? "regional" : "gateway", started, 200);
    return result;
  } catch (cause) {
    if (direct && routeFailure(cause)) {
      browserClients.delete(workspaceId);
      canonicalUntil.set(workspaceId, Date.now() + 30_000);
      await client.destroy();
      const canonical = createCanonicalClient(workspaceId);
      try {
        const result = await operation(canonical);
        report("total", "gateway", started, 200);
        return result;
      } catch (fallbackCause) {
        throw datafnError(fallbackCause);
      } finally {
        await canonical.destroy();
      }
    }
    throw datafnError(cause);
  } finally {
    if (!direct) await client.destroy();
  }
}
