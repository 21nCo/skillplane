import { apiRequest, jsonBody } from "$lib/api/client.js";
export interface Source {
  id: string;
  workspaceId: string;
  repositoryUrl: string;
  ref: string;
  refPolicy: "track" | "pin";
  path: string | null;
  revision: number;
  archivedAt: string | null;
  updatedAt: string;
}
export interface Plan {
  path: string;
  slug: string | null;
  action: string;
  message: string | null;
  digest: string | null;
  skillId: string | null;
}
export interface Run {
  id: string;
  commitSha: string;
  status: string;
  failureMessage: string | null;
  createdAt: string;
  plan: Plan[];
  results: {
    path: string;
    status: string;
    message: string | null;
    skillId: string | null;
    versionId: string | null;
  }[];
}
export interface SourceDetail {
  source: Source;
  bindings: {
    path: string;
    skillId: string;
    slug: string;
    name: string;
    status: string;
    disconnectedAt: string | null;
    lastCommitSha: string | null;
    lastDigest: string | null;
    lastVersionId: string | null;
  }[];
  runs: Run[];
}
export function sourceRequest<T>(
  workspaceId: string,
  path = "",
  method = "GET",
  body?: unknown,
  idempotencyKey = crypto.randomUUID(),
) {
  return apiRequest<T>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/sources${path}`,
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
