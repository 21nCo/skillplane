import { DomainError, WorkspaceAccessError } from "@skillplane/domain";
import { readAnalytics } from "@skillplane/observability";
import type { Context, Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import { requirePrincipal } from "./shared.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_RANGE_DAYS = 366;

function day(value: string | undefined, fallback: Date): string {
  if (!value) return fallback.toISOString().slice(0, 10);
  if (!DAY.test(value) || Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())) {
    throw new DomainError("VALIDATION_FAILED", "Date filters must use YYYY-MM-DD", 400);
  }
  return value;
}

function dateRange(context: Context<ApiEnvironment>): {
  readonly from: string;
  readonly to: string;
} {
  const today = new Date();
  const fallbackFrom = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1_000);
  const from = day(context.req.query("from"), fallbackFrom);
  const to = day(context.req.query("to"), today);
  const fromTime = new Date(`${from}T00:00:00.000Z`).getTime();
  const toTime = new Date(`${to}T00:00:00.000Z`).getTime();
  if (fromTime > toTime || toTime - fromTime > MAX_RANGE_DAYS * 86_400_000) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Analytics ranges must be ordered and at most ${String(MAX_RANGE_DAYS)} days`,
      400,
    );
  }
  return { from, to };
}

async function assertSkill(
  context: Context<ApiEnvironment>,
  workspaceId: string,
  skillId: string,
): Promise<void> {
  const services = context.get("services");
  if (!services) throw new WorkspaceAccessError();
  const skill = await services.database.pool.query(
    "SELECT 1 FROM skills WHERE workspace_id = $1 AND id = $2 LIMIT 1",
    [workspaceId, skillId],
  );
  if (!skill.rowCount) {
    throw new DomainError("SKILL_NOT_FOUND", "The skill was not found", 404);
  }
}

export function registerAnalyticsRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/analytics/workspaces/:workspaceId", async (context) => {
    const principal = requirePrincipal(context);
    const workspaceId = context.req.param("workspaceId");
    if (principal.workspaceId !== workspaceId) throw new WorkspaceAccessError();
    const services = context.get("services");
    if (!services) throw new WorkspaceAccessError();
    const range = dateRange(context);
    return context.json(
      success(context, {
        analytics: await readAnalytics(services.database.pool, {
          workspaceId,
          ...range,
        }),
      }),
    );
  });

  app.get(
    "/api/v1/analytics/workspaces/:workspaceId/skills/:skillId",
    async (context) => {
      const principal = requirePrincipal(context);
      const workspaceId = context.req.param("workspaceId");
      const skillId = context.req.param("skillId");
      if (principal.workspaceId !== workspaceId) throw new WorkspaceAccessError();
      const services = context.get("services");
      if (!services) throw new WorkspaceAccessError();
      await assertSkill(context, workspaceId, skillId);
      const range = dateRange(context);
      return context.json(
        success(context, {
          analytics: await readAnalytics(services.database.pool, {
            workspaceId,
            skillId,
            ...range,
          }),
        }),
      );
    },
  );
}
