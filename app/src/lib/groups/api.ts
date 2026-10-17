import { apiRequest, jsonBody } from "$lib/api/client.js";
export interface Group {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  revision: number;
  archivedAt: string | null;
}
export interface Member {
  userId: string;
  role: string;
  displayName: string | null;
  email: string | null;
}
export function groupRequest<T>(
  workspaceId: string,
  path = "",
  method = "GET",
  body?: unknown,
  idempotencyKey = crypto.randomUUID(),
) {
  return apiRequest<T>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/groups${path}`,
    {
      method,
      headers: {
        "x-skillplane-workspace-id": workspaceId,
        "idempotency-key": idempotencyKey,
      },
      ...(body === undefined ? {} : jsonBody(body)),
    },
  );
}
