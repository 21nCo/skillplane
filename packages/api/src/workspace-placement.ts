import {
  selectInitialWorkspaceRegion,
  selectNearestWorkspaceRegion,
  type WorkspaceClientLocation,
  type WorkspaceRegionCandidate,
} from "@skillplane/control-plane";
import { DomainError } from "@skillplane/domain";
import type { ApiServices } from "./context.js";

export const TRUSTED_WORKSPACE_REGION_HEADER = "x-skillplane-placement-region";

interface CloudflareLocationRequest extends Request {
  readonly cf?: {
    readonly continent?: unknown;
    readonly latitude?: unknown;
    readonly longitude?: unknown;
  };
}

function coordinate(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

export function clientLocationFromEdgeRequest(
  request: Request,
): WorkspaceClientLocation | null {
  const cf = (request as CloudflareLocationRequest).cf;
  if (!cf) return null;
  const latitude = coordinate(cf.latitude, -90, 90);
  const longitude = coordinate(cf.longitude, -180, 180);
  const continent =
    typeof cf.continent === "string" && /^[A-Za-z]{2}$/u.test(cf.continent)
      ? cf.continent.toUpperCase()
      : undefined;
  if (latitude === undefined && longitude === undefined && !continent) return null;
  return {
    ...(latitude === undefined ? {} : { latitude }),
    ...(longitude === undefined ? {} : { longitude }),
    ...(continent ? { continent } : {}),
  };
}

export function recommendedWorkspaceRegionFromEdge(
  request: Request,
  candidates: readonly WorkspaceRegionCandidate[],
): string | null {
  return selectNearestWorkspaceRegion(
    clientLocationFromEdgeRequest(request),
    candidates,
  );
}

export function trustedWorkspaceRegion(
  request: Request,
  services: Pick<ApiServices, "deploymentRole" | "workspaceRegions">,
): string | null {
  if (services.deploymentRole !== "gateway") return null;
  const value = request.headers.get(TRUSTED_WORKSPACE_REGION_HEADER);
  return value && services.workspaceRegions.includes(value) ? value : null;
}

export function initialWorkspaceRegionForRequest(
  request: Request,
  services: Pick<ApiServices, "deploymentRole" | "workspaceRegions">,
  workspaceKey: string,
): string {
  const preferredRegionId = trustedWorkspaceRegion(request, services);
  if (services.deploymentRole === "gateway" && !preferredRegionId) {
    throw new DomainError(
      "WORKSPACE_REGION_UNAVAILABLE",
      "A nearby workspace region could not be determined",
      503,
    );
  }
  return selectInitialWorkspaceRegion(
    workspaceKey,
    services.workspaceRegions,
    preferredRegionId,
  );
}
