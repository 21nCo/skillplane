import { routeTicketError, withDatafnRegionalCors } from "@datafn/server";
import type { SkillplaneTopologyManifest } from "@skillplane/control-plane";

interface RegionalDatafnBindings {
  readonly SKILLPLANE_TOPOLOGY: string;
  readonly SKILLPLANE_REGION_ID: string;
  readonly DATAFN_DIRECT_ENABLED?: string;
  readonly CELL_APP: { fetch(request: Request): Promise<Response> };
  readonly DATAFN_EDGE_LIMIT: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
}

const routes = new Set(["/datafn/query", "/datafn/search"]);
const forbiddenHeaders = [
  "cookie",
  "authorization",
  "x-datafn-routing-assertion",
  "x-datafn-routing-namespace",
  "x-datafn-routing-region",
  "x-datafn-routing-epoch",
];

/** The only public regional Worker. All other cell routes remain service-bound. */
export default {
  async fetch(request: Request, env: RegionalDatafnBindings): Promise<Response> {
    const url = new URL(request.url);
    if (
      !routes.has(url.pathname) ||
      url.search ||
      (request.method !== "POST" && request.method !== "OPTIONS")
    ) {
      return new Response(null, { status: 404 });
    }
    if (
      request.method === "OPTIONS" &&
      request.headers.get("access-control-request-method") !== "POST"
    ) {
      return new Response(null, { status: 403 });
    }
    if (env.DATAFN_DIRECT_ENABLED !== "true")
      return new Response(null, { status: 404 });
    const topology = JSON.parse(env.SKILLPLANE_TOPOLOGY) as SkillplaneTopologyManifest;
    const cell = topology.cells.find(
      (candidate) => candidate.regionId === env.SKILLPLANE_REGION_ID,
    );
    if (
      !cell?.datafnEndpoint ||
      new URL(cell.datafnEndpoint.httpUrl).origin !== url.origin
    ) {
      return new Response(null, { status: 503 });
    }
    const appOrigin = new URL(topology.public.appAuthority).origin;
    const handle = withDatafnRegionalCors(
      async (admitted) => {
        if (
          !(
            await env.DATAFN_EDGE_LIMIT.limit({
              key: `${env.SKILLPLANE_REGION_ID}:${admitted.headers.get("cf-connecting-ip") ?? "unknown"}`,
            })
          ).success
        )
          return routeTicketError("DATAFN_ROUTE_RATE_LIMITED").toResponse();
        if (
          forbiddenHeaders.some((header) => admitted.headers.has(header)) ||
          !admitted.headers.has("x-datafn-route-ticket")
        ) {
          return new Response(null, { status: 401 });
        }
        const forwarded = new Request(new URL(url.pathname, appOrigin), admitted);
        return env.CELL_APP.fetch(forwarded);
      },
      {
        origins: [appOrigin],
        headers: ["x-skillplane-workspace-id"],
      },
    );
    return handle(request);
  },
};
