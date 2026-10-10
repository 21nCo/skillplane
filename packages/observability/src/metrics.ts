import type { Pool } from "pg";

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

interface SummaryRow {
  readonly day: string;
  readonly event_count: string;
  readonly retrieval_count: string;
  readonly amendment_count: string;
  readonly approval_count: string;
  readonly context_write_count: string;
  readonly failure_count: string;
  readonly unique_principal_count: string;
  readonly unique_agent_count: string;
  readonly unique_model_count: string;
  readonly latency_p50_ms: number | null;
  readonly latency_p95_ms: number | null;
  readonly current_version_retrieval_count: string;
  readonly versioned_retrieval_count: string;
}

interface DimensionRow {
  readonly dimension_type: AnalyticsDimension["type"];
  readonly dimension_value: string;
  readonly event_count: string;
  readonly failure_count: string;
  readonly unique_principal_count: string;
}

function count(value: string | number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function weightedLatency(
  points: readonly AnalyticsPoint[],
  key: "latencyP50Ms" | "latencyP95Ms",
): number | null {
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const value = point[key];
    if (value === null || point.retrievalCount === 0) continue;
    numerator += value * point.retrievalCount;
    denominator += point.retrievalCount;
  }
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10) / 10;
}

export async function readAnalytics(
  pool: Pool,
  options: {
    readonly workspaceId: string;
    readonly from: string;
    readonly to: string;
    readonly skillId?: string;
    readonly dimensionLimit?: number;
  },
): Promise<AnalyticsSnapshot> {
  const skillId = options.skillId ?? "";
  const summary = await pool.query<SummaryRow>(
    `SELECT day::text, event_count::text, retrieval_count::text,
            amendment_count::text, approval_count::text,
            context_write_count::text, failure_count::text,
            unique_principal_count::text, unique_agent_count::text,
            unique_model_count::text, latency_p50_ms, latency_p95_ms,
            current_version_retrieval_count::text,
            versioned_retrieval_count::text
       FROM analytics_daily_summary
      WHERE workspace_id = $1 AND skill_id = $2
        AND day BETWEEN $3::date AND $4::date
      ORDER BY day`,
    [options.workspaceId, skillId, options.from, options.to],
  );
  const points: AnalyticsPoint[] = summary.rows.map((row) => ({
    day: row.day,
    eventCount: count(row.event_count),
    retrievalCount: count(row.retrieval_count),
    amendmentCount: count(row.amendment_count),
    approvalCount: count(row.approval_count),
    contextWriteCount: count(row.context_write_count),
    failureCount: count(row.failure_count),
    uniquePrincipalCount: count(row.unique_principal_count),
    uniqueAgentCount: count(row.unique_agent_count),
    uniqueModelCount: count(row.unique_model_count),
    latencyP50Ms: row.latency_p50_ms,
    latencyP95Ms: row.latency_p95_ms,
    currentVersionRetrievalCount: count(row.current_version_retrieval_count),
    versionedRetrievalCount: count(row.versioned_retrieval_count),
  }));
  const dimensions = await pool.query<DimensionRow>(
    `SELECT dimension_type, dimension_value,
            sum(event_count)::text AS event_count,
            sum(failure_count)::text AS failure_count,
            max(unique_principal_count)::text AS unique_principal_count
       FROM analytics_daily_dimensions
      WHERE workspace_id = $1 AND skill_id = $2
        AND day BETWEEN $3::date AND $4::date
      GROUP BY dimension_type, dimension_value
      ORDER BY sum(event_count) DESC, dimension_type, dimension_value
      LIMIT $5`,
    [
      options.workspaceId,
      skillId,
      options.from,
      options.to,
      Math.min(100, Math.max(1, options.dimensionLimit ?? 50)),
    ],
  );
  const totalsBase = points.reduce(
    (totals, point) => ({
      eventCount: totals.eventCount + point.eventCount,
      retrievalCount: totals.retrievalCount + point.retrievalCount,
      amendmentCount: totals.amendmentCount + point.amendmentCount,
      approvalCount: totals.approvalCount + point.approvalCount,
      contextWriteCount: totals.contextWriteCount + point.contextWriteCount,
      failureCount: totals.failureCount + point.failureCount,
      uniquePrincipalCount: Math.max(
        totals.uniquePrincipalCount,
        point.uniquePrincipalCount,
      ),
      uniqueAgentCount: Math.max(totals.uniqueAgentCount, point.uniqueAgentCount),
      uniqueModelCount: Math.max(totals.uniqueModelCount, point.uniqueModelCount),
      currentVersionRetrievalCount:
        totals.currentVersionRetrievalCount + point.currentVersionRetrievalCount,
      versionedRetrievalCount:
        totals.versionedRetrievalCount + point.versionedRetrievalCount,
    }),
    {
      eventCount: 0,
      retrievalCount: 0,
      amendmentCount: 0,
      approvalCount: 0,
      contextWriteCount: 0,
      failureCount: 0,
      uniquePrincipalCount: 0,
      uniqueAgentCount: 0,
      uniqueModelCount: 0,
      currentVersionRetrievalCount: 0,
      versionedRetrievalCount: 0,
    },
  );
  const latest = await pool.query<{ completed_at: Date | null }>(
    `SELECT max(completed_at) AS completed_at
       FROM analytics_rollup_runs
      WHERE workspace_id = $1 AND day BETWEEN $2::date AND $3::date`,
    [options.workspaceId, options.from, options.to],
  );
  return {
    from: options.from,
    to: options.to,
    generatedAt: latest.rows[0]?.completed_at?.toISOString() ?? null,
    totals: {
      ...totalsBase,
      latencyP50Ms: weightedLatency(points, "latencyP50Ms"),
      latencyP95Ms: weightedLatency(points, "latencyP95Ms"),
      adoptionRate:
        totalsBase.versionedRetrievalCount === 0
          ? null
          : totalsBase.currentVersionRetrievalCount /
            totalsBase.versionedRetrievalCount,
      failureRate:
        totalsBase.eventCount === 0
          ? null
          : totalsBase.failureCount / totalsBase.eventCount,
    },
    points,
    dimensions: dimensions.rows.map((row) => ({
      type: row.dimension_type,
      value: row.dimension_value,
      eventCount: count(row.event_count),
      failureCount: count(row.failure_count),
      uniquePrincipalCount: count(row.unique_principal_count),
      trust:
        row.dimension_type === "agent" || row.dimension_type === "model"
          ? "caller-declared"
          : row.dimension_type === "outcome"
            ? "authenticated"
            : "system-derived",
    })),
  };
}
