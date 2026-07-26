import { apiRequest, SkillplaneApiError } from "$lib/api/client.js";
import type { AuditFilterValues, AuditPage } from "./types.js";

function query(filters: AuditFilterValues, cursor?: string): URLSearchParams {
  const values = new URLSearchParams({ from: filters.from, to: filters.to });
  const optionalFilters = [
    ["outcome", filters.outcome],
    ["tool", filters.tool],
    ["agent", filters.agent],
    ["model", filters.model],
    ["contextId", filters.contextId],
  ] as const;
  for (const [key, value] of optionalFilters) {
    if (value) values.set(key, value);
  }
  if (cursor) values.set("cursor", cursor);
  values.set("limit", "50");
  return values;
}

function path(options: {
  readonly workspaceId: string;
  readonly skillId?: string;
  readonly exportCsv?: boolean;
}): string {
  const skill = options.skillId ? `/skills/${options.skillId}` : "";
  const exportPath = options.exportCsv ? "/export" : "";
  return `/api/v1/audit/workspaces/${options.workspaceId}${skill}${exportPath}`;
}

export async function getAuditEvents(options: {
  readonly workspaceId: string;
  readonly skillId?: string;
  readonly filters: AuditFilterValues;
  readonly cursor?: string;
}): Promise<AuditPage> {
  const data = await apiRequest<{ audit: AuditPage }>(
    `${path(options)}?${query(options.filters, options.cursor)}`,
    {
      headers: { "x-skillplane-workspace-id": options.workspaceId },
    },
  );
  return data.audit;
}

export async function downloadAuditCsv(options: {
  readonly workspaceId: string;
  readonly skillId?: string;
  readonly filters: AuditFilterValues;
}): Promise<void> {
  const response = await fetch(
    `${path({ ...options, exportCsv: true })}?${query(options.filters)}`,
    {
      credentials: "include",
      headers: {
        accept: "text/csv",
        "x-skillplane-workspace-id": options.workspaceId,
      },
    },
  );
  if (!response.ok) {
    let body:
      | {
          readonly error?: {
            readonly code: string;
            readonly message: string;
            readonly requestId: string;
          };
        }
      | undefined;
    try {
      body = (await response.json()) as typeof body;
    } catch {
      body = undefined;
    }
    throw new SkillplaneApiError(response.status, body?.error);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `skillplane-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}
