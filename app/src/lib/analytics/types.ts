export interface AnalyticsPoint {
  readonly day: string;
  readonly eventCount: number;
  readonly retrievalCount: number;
  readonly amendmentCount: number;
  readonly approvalCount: number;
  readonly contextWriteCount: number;
  readonly failureCount: number;
  readonly uniquePrincipalCount: number;
  readonly uniqueAgentCount: number;
  readonly uniqueModelCount: number;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly currentVersionRetrievalCount: number;
  readonly versionedRetrievalCount: number;
}

export interface AnalyticsDimension {
  readonly type: "agent" | "model" | "context" | "tool" | "outcome" | "version";
  readonly value: string;
  readonly eventCount: number;
  readonly failureCount: number;
  readonly uniquePrincipalCount: number;
  readonly trust: "caller-declared" | "authenticated" | "system-derived";
}

export interface AnalyticsSnapshot {
  readonly from: string;
  readonly to: string;
  readonly generatedAt: string | null;
  readonly totals: Omit<AnalyticsPoint, "day"> & {
    readonly adoptionRate: number | null;
    readonly failureRate: number | null;
  };
  readonly points: readonly AnalyticsPoint[];
  readonly dimensions: readonly AnalyticsDimension[];
}
