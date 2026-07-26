import { apiRequest } from "$lib/api/client.js";
import type { AnalyticsSnapshot } from "./types.js";

export async function getAnalytics(options: {
  readonly workspaceId: string;
  readonly from: string;
  readonly to: string;
  readonly skillId?: string;
}): Promise<AnalyticsSnapshot> {
  const query = new URLSearchParams({ from: options.from, to: options.to });
  const suffix = options.skillId ? `/skills/${options.skillId}` : "";
  const data = await apiRequest<{ analytics: AnalyticsSnapshot }>(
    `/api/v1/analytics/workspaces/${options.workspaceId}${suffix}?${query}`,
    {
      headers: { "x-skillplane-workspace-id": options.workspaceId },
    },
  );
  return data.analytics;
}
