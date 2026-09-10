import { DomainError, WorkspaceAccessError } from "@skillplane/domain";
import {
  exportAuditEventsCsv,
  readAuditEvents,
  type AuditFilters,
  type AuditOutcome,
} from "@skillplane/observability";
import type { Context, Hono } from "hono";
import type { ApiEnvironment, ApiServices } from "../context.js";
import { success } from "../envelopes.js";
import { requirePrincipal } from "./shared.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const FILTER = /^[\p{L}\p{N} ._:@/+()-]{1,200}$/u;

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  if (!DAY.test(value)) {
    throw new DomainError("VALIDATION_FAILED", "Date filters must use YYYY-MM-DD", 400);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DomainError("VALIDATION_FAILED", "Date filters are invalid", 400);
  }
  return parsed;
}

function textFilter(
  context: Context<ApiEnvironment>,
  name: string,
): string | undefined {
  const value = context.req.query(name)?.trim();
  if (!value) return undefined;
  if (!FILTER.test(value)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${name} contains unsupported characters`,
      400,
      { field: name },
    );
  }
  return value;
}

function filters(context: Context<ApiEnvironment>, skillId?: string): AuditFilters {
  const now = new Date();
  const from = parseDate(
    context.req.query("from"),
    new Date(now.getTime() - 29 * 86_400_000),
  );
  const toDay = parseDate(context.req.query("to"), now);
  const to = new Date(toDay.getTime() + 86_400_000);
  if (from >= to || to.getTime() - from.getTime() > 367 * 86_400_000) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Audit ranges must be ordered and at most 366 days",
      400,
    );
  }
  const outcomeValue = textFilter(context, "outcome");
  if (
    outcomeValue &&
    !(["success", "denied", "error"] as const).includes(outcomeValue as AuditOutcome)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "outcome must be success, denied, or error",
      400,
      { field: "outcome" },
    );
  }
  const selectedSkillId = skillId ?? textFilter(context, "skillId");
  const contextId = textFilter(context, "contextId");
  const tool = textFilter(context, "tool");
  const agent = textFilter(context, "agent");
  const model = textFilter(context, "model");
  return {
    from,
    to,
    ...(selectedSkillId ? { skillId: selectedSkillId } : {}),
    ...(contextId ? { contextId } : {}),
    ...(tool ? { tool } : {}),
    ...(outcomeValue ? { outcome: outcomeValue as AuditOutcome } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
  };
}

async function scope(context: Context<ApiEnvironment>): Promise<{
  readonly workspaceId: string;
  readonly skillId?: string;
  readonly services: ApiServices;
}> {
  const principal = requirePrincipal(context);
  const workspaceId = context.req.param("workspaceId");
  if (principal.workspaceId !== workspaceId) throw new WorkspaceAccessError();
  const services = context.get("services");
  if (!services) throw new WorkspaceAccessError();
  const skillId = context.req.param("skillId");
  if (skillId) {
    const skill = await services.database.pool.query(
      "SELECT 1 FROM skills WHERE workspace_id = $1 AND id = $2 LIMIT 1",
      [workspaceId, skillId],
    );
    if (!skill.rowCount) {
      throw new DomainError("SKILL_NOT_FOUND", "The skill was not found", 404);
    }
  }
  return { workspaceId, services, ...(skillId ? { skillId } : {}) };
}

async function list(context: Context<ApiEnvironment>) {
  const { workspaceId, skillId, services } = await scope(context);
  const cursor = context.req.query("cursor");
  const limitValue = context.req.query("limit");
  const limit = limitValue ? Number(limitValue) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "limit must be an integer from 1 to 100",
      400,
      { field: "limit" },
    );
  }
  let page;
  try {
    page = await readAuditEvents(services.database.pool, {
      workspaceId,
      filters: filters(context, skillId),
      cursorSecret: services.tenancySecret,
      controlPool: services.controlDatabase.pool,
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Audit cursor is invalid") {
      throw new DomainError("VALIDATION_FAILED", error.message, 400, {
        field: "cursor",
      });
    }
    throw error;
  }
  return context.json(success(context, { audit: page }));
}

async function exportCsv(context: Context<ApiEnvironment>): Promise<Response> {
  const { workspaceId, skillId, services } = await scope(context);
  const csv = await exportAuditEventsCsv(services.database.pool, {
    workspaceId,
    filters: filters(context, skillId),
    controlPool: services.controlDatabase.pool,
  });
  context.header("content-type", "text/csv; charset=utf-8");
  context.header(
    "content-disposition",
    `attachment; filename="skillplane-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
  );
  context.header("cache-control", "private, no-store");
  return context.body(csv);
}

export function registerAuditRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/audit/workspaces/:workspaceId", list);
  app.get("/api/v1/audit/workspaces/:workspaceId/export", exportCsv);
  app.get("/api/v1/audit/workspaces/:workspaceId/skills/:skillId", list);
  app.get("/api/v1/audit/workspaces/:workspaceId/skills/:skillId/export", exportCsv);
}
