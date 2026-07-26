import {
  apiRequest,
  jsonBody,
  SkillplaneApiError,
  type ApiErrorBody,
} from "$lib/api/client.js";
import type {
  AmendmentPolicy,
  AmendmentReviewDetail,
  AmendmentReviewStatus,
  PublicSkill,
  SemanticBump,
  Skill,
  SkillArchiveFilter,
  SkillPage,
  SkillVersion,
  SkillVersionDiff,
  SkillVisibility,
} from "./types.js";

interface CreateSkillResult {
  readonly skill: Skill;
  readonly version: SkillVersion;
}

function workspaceHeaders(workspaceId: string, idempotencyKey?: string): Headers {
  const headers = new Headers({ "x-skillplane-workspace-id": workspaceId });
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return headers;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function appendValues(
  query: URLSearchParams,
  name: string,
  values: readonly string[],
): void {
  for (const value of values) query.append(name, value);
}

export async function listSkills(options: {
  readonly workspaceId: string;
  readonly query?: string;
  readonly visibility?: readonly SkillVisibility[];
  readonly archive?: SkillArchiveFilter;
  readonly cursor?: string | null;
  readonly limit?: number;
}): Promise<SkillPage> {
  const query = new URLSearchParams({
    state: options.archive ?? "active",
    limit: String(options.limit ?? 20),
  });
  if (options.query?.trim()) query.set("q", options.query.trim());
  if (options.cursor) query.set("cursor", options.cursor);
  appendValues(query, "visibility", options.visibility ?? []);
  return apiRequest<SkillPage>(
    `/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}/skills?${query.toString()}`,
    { headers: workspaceHeaders(options.workspaceId) },
  );
}

export async function getSkillBySlug(
  workspaceId: string,
  skillSlug: string,
): Promise<Skill> {
  const data = await apiRequest<{ skill: Skill }>(
    `/api/v1/workspaces/${encodeURIComponent(
      workspaceId,
    )}/skills/by-slug/${encodeURIComponent(skillSlug)}`,
    { headers: workspaceHeaders(workspaceId) },
  );
  return data.skill;
}

export async function getPublicSkill(
  workspaceSlug: string,
  skillSlug: string,
): Promise<PublicSkill> {
  return apiRequest<PublicSkill>(
    `/api/v1/skills/public/${encodeURIComponent(
      workspaceSlug,
    )}/${encodeURIComponent(skillSlug)}`,
  );
}

export async function createSkill(options: {
  readonly workspaceId: string;
  readonly bundleBase64: string;
  readonly visibility: SkillVisibility;
  readonly idempotencyKey: string;
}): Promise<CreateSkillResult> {
  return apiRequest<CreateSkillResult>(
    `/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}/skills`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({
        bundleBase64: options.bundleBase64,
        visibility: options.visibility,
      }),
    },
  );
}

export async function getSkill(workspaceId: string, skillId: string): Promise<Skill> {
  const data = await apiRequest<{ skill: Skill }>(
    `/api/v1/skills/${encodeURIComponent(skillId)}`,
    { headers: workspaceHeaders(workspaceId) },
  );
  return data.skill;
}

export async function listSkillVersions(
  workspaceId: string,
  skillId: string,
): Promise<readonly SkillVersion[]> {
  const data = await apiRequest<{ versions: readonly SkillVersion[] }>(
    `/api/v1/skills/${encodeURIComponent(skillId)}/versions?limit=100`,
    { headers: workspaceHeaders(workspaceId) },
  );
  return data.versions;
}

export async function getSkillVersion(
  workspaceId: string,
  skillId: string,
  versionId: string,
): Promise<SkillVersion> {
  const data = await apiRequest<{ version: SkillVersion }>(
    `/api/v1/skills/${encodeURIComponent(
      skillId,
    )}/versions/${encodeURIComponent(versionId)}`,
    { headers: workspaceHeaders(workspaceId) },
  );
  return data.version;
}

export async function getSkillDiff(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly fromVersionId: string;
  readonly toVersionId: string;
}): Promise<SkillVersionDiff> {
  const query = new URLSearchParams({
    from: options.fromVersionId,
    to: options.toVersionId,
  });
  const data = await apiRequest<{ diff: SkillVersionDiff }>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}/diff?${query.toString()}`,
    { headers: workspaceHeaders(options.workspaceId) },
  );
  return data.diff;
}

async function rawFileRequest(path: string, workspaceId?: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      headers: workspaceId ? workspaceHeaders(workspaceId) : undefined,
    });
  } catch {
    throw new SkillplaneApiError(0, {
      code: "NETWORK_UNAVAILABLE",
      message: "Skillplane could not be reached. Check your connection and retry.",
      requestId: "",
    });
  }
  if (response.ok) return response;
  let body: ApiErrorBody | undefined;
  try {
    const envelope = (await response.json()) as {
      readonly ok?: boolean;
      readonly error?: ApiErrorBody;
    };
    body = envelope.error;
  } catch {
    body = undefined;
  }
  throw new SkillplaneApiError(response.status, body);
}

export async function getSkillFile(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly versionId: string;
  readonly path: string;
}): Promise<Response> {
  return rawFileRequest(
    `/api/v1/skills/${encodeURIComponent(
      options.skillId,
    )}/versions/${encodeURIComponent(options.versionId)}/files/${encodePath(
      options.path,
    )}`,
    options.workspaceId,
  );
}

export async function getSkillBundle(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly versionId: string;
}): Promise<Uint8Array> {
  const response = await rawFileRequest(
    `/api/v1/skills/${encodeURIComponent(
      options.skillId,
    )}/versions/${encodeURIComponent(options.versionId)}/bundle`,
    options.workspaceId,
  );
  return new Uint8Array(await response.arrayBuffer());
}

export async function getPublicSkillFile(options: {
  readonly skillId: string;
  readonly versionId: string;
  readonly path: string;
}): Promise<Response> {
  return rawFileRequest(
    `/api/v1/skills/${encodeURIComponent(
      options.skillId,
    )}/versions/${encodeURIComponent(options.versionId)}/files/${encodePath(
      options.path,
    )}`,
  );
}

export async function createSkillCandidate(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly baseVersionId: string;
  readonly proposedBump: SemanticBump;
  readonly changeSummary: string;
  readonly bundleBase64: string;
  readonly idempotencyKey: string;
}): Promise<SkillVersion> {
  const data = await apiRequest<{ version: SkillVersion }>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}/versions`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({
        bundleBase64: options.bundleBase64,
        baseVersionId: options.baseVersionId,
        proposedBump: options.proposedBump,
        changeSummary: options.changeSummary,
      }),
    },
  );
  return data.version;
}

export async function publishCandidate(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly versionId: string;
  readonly idempotencyKey: string;
}): Promise<SkillVersion> {
  const data = await apiRequest<{ version: SkillVersion }>(
    `/api/v1/skills/${encodeURIComponent(
      options.skillId,
    )}/candidates/${encodeURIComponent(options.versionId)}/approve`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
    },
  );
  return data.version;
}

export async function rejectCandidate(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly versionId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}): Promise<SkillVersion> {
  const data = await apiRequest<{ version: SkillVersion }>(
    `/api/v1/skills/${encodeURIComponent(
      options.skillId,
    )}/candidates/${encodeURIComponent(options.versionId)}/reject`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({ reason: options.reason }),
    },
  );
  return data.version;
}

export async function setSkillVisibility(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly visibility: SkillVisibility;
  readonly idempotencyKey: string;
}): Promise<Skill> {
  const data = await apiRequest<{ skill: Skill }>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}`,
    {
      method: "PATCH",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({ visibility: options.visibility }),
    },
  );
  return data.skill;
}

export async function setSkillArchived(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly archived: boolean;
  readonly idempotencyKey: string;
}): Promise<Skill> {
  const data = await apiRequest<{ skill: Skill }>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}/${
      options.archived ? "archive" : "restore"
    }`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
    },
  );
  return data.skill;
}

export async function listAmendmentReviews(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly status?: AmendmentReviewStatus | "all";
}): Promise<readonly AmendmentReviewDetail[]> {
  const query = new URLSearchParams({ status: options.status ?? "all" });
  const data = await apiRequest<{ reviews: readonly AmendmentReviewDetail[] }>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}/candidates?${query.toString()}`,
    { headers: workspaceHeaders(options.workspaceId) },
  );
  return data.reviews;
}

export async function getAmendmentReview(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly reviewId: string;
}): Promise<AmendmentReviewDetail> {
  return apiRequest<AmendmentReviewDetail>(
    `/api/v1/skills/${encodeURIComponent(
      options.skillId,
    )}/candidates/${encodeURIComponent(options.reviewId)}`,
    { headers: workspaceHeaders(options.workspaceId) },
  );
}

export async function decideAmendmentReview(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly reviewId: string;
  readonly decision: "approve" | "reject";
  readonly reason: string;
  readonly idempotencyKey: string;
}): Promise<AmendmentReviewDetail> {
  return apiRequest<AmendmentReviewDetail>(
    `/api/v1/skills/${encodeURIComponent(
      options.skillId,
    )}/reviews/${encodeURIComponent(options.reviewId)}/${options.decision}`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({ reason: options.reason }),
    },
  );
}

export async function getAmendmentPolicy(options: {
  readonly workspaceId: string;
  readonly skillId: string;
}): Promise<AmendmentPolicy> {
  const data = await apiRequest<{ policy: AmendmentPolicy }>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}/amendment-policy`,
    { headers: workspaceHeaders(options.workspaceId) },
  );
  return data.policy;
}

export async function updateAmendmentPolicy(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly policy: AmendmentPolicy;
  readonly idempotencyKey: string;
}): Promise<AmendmentPolicy> {
  const data = await apiRequest<{ policy: AmendmentPolicy }>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}/amendment-policy`,
    {
      method: "PUT",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({ policy: options.policy }),
    },
  );
  return data.policy;
}
