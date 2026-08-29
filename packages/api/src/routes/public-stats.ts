import { DomainError } from "@skillplane/domain";
import { readPublicStats } from "@skillplane/observability";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";

const CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

export function registerPublicStatsRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/stats/public", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "Public statistics are unavailable",
        503,
      );
    }
    const stats = await readPublicStats(services.controlDatabase.pool, {
      projected: services.deploymentRole !== "single",
    });
    context.header("Cache-Control", CACHE_CONTROL);
    return context.json(
      success(context, {
        ...stats,
        generatedAt: new Date().toISOString(),
      }),
    );
  });
}
