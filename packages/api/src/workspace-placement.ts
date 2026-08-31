import {
  readDatafnCloudflarePlacementLocation,
  selectDatafnPlacementRegion,
  type DatafnPlacementLocation,
} from "@datafn/server/placement";
import { DomainError } from "@skillplane/domain";
import type { ApiServices, WorkspaceRegionCandidate } from "./context.js";

export const TRUSTED_WORKSPACE_REGION_HEADER = "x-skillplane-placement-region";

export function clientLocationFromEdgeRequest(
  request: Request,
): DatafnPlacementLocation | null {
  return readDatafnCloudflarePlacementLocation(request);
}

export function recommendedWorkspaceRegionFromEdge(
  request: Request,
  candidates: readonly WorkspaceRegionCandidate[],
): string | null {
  return (
    selectDatafnPlacementRegion({
      candidates,
      location: clientLocationFromEdgeRequest(request),
    })?.regionId ?? null
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
  const decision = selectDatafnPlacementRegion({
    candidates: services.workspaceRegions.map((regionId) => ({ regionId })),
    preferredRegionId,
    ...(services.deploymentRole === "gateway" ? {} : { stableKey: workspaceKey }),
  });
  if (!decision) {
    throw new DomainError(
      "WORKSPACE_REGION_UNAVAILABLE",
      "A workspace region could not be determined",
      503,
    );
  }
  return decision.regionId;
}
