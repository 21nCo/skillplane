import { apiRequest, SkillplaneApiError } from "$lib/api/client.js";
import { withWorkspaceDatafnClient } from "$lib/datafn/client.js";
import type {
  AmendmentPolicyDecision,
  CallerDeclaration,
  LearningMetadata,
  SemanticBump,
  Skill,
  SkillArchiveFilter,
  SkillBundleManifest,
  SkillPage,
  SkillVersion,
  SkillVersionStatus,
  SkillVisibility,
} from "./types.js";

type DatafnRecord = Readonly<Record<string, unknown>>;

function requiredString(row: DatafnRecord, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`DataFn returned an invalid ${field} field`);
  }
  return value;
}

function optionalString(row: DatafnRecord, field: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`DataFn returned an invalid ${field} field`);
  }
  return value;
}

function dateString(row: DatafnRecord, field: string): string {
  const value = row[field];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  throw new Error(`DataFn returned an invalid ${field} field`);
}

function optionalDateString(row: DatafnRecord, field: string): string | null {
  return row[field] === null || row[field] === undefined
    ? null
    : dateString(row, field);
}

function recordValue(row: DatafnRecord, field: string): Record<string, unknown> {
  const value = row[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(row: DatafnRecord, field: string): readonly unknown[] {
  const value = row[field];
  return Array.isArray(value) ? value : [];
}

function skillFromDatafn(row: DatafnRecord, workspaceId: string): Skill {
  const currentVersion = row.currentVersion;
  const currentSemanticVersion =
    currentVersion &&
    typeof currentVersion === "object" &&
    !Array.isArray(currentVersion)
      ? optionalString(currentVersion as DatafnRecord, "semanticVersion")
      : null;
  return {
    id: requiredString(row, "id"),
    workspaceId,
    slug: requiredString(row, "slug"),
    name: requiredString(row, "name"),
    description: requiredString(row, "description"),
    tags: arrayValue(row, "tags").filter(
      (tag): tag is string => typeof tag === "string",
    ),
    visibility: requiredString(row, "visibility") as SkillVisibility,
    currentPublishedVersionId: optionalString(row, "currentPublishedVersionId"),
    currentSemanticVersion,
    archivedAt: optionalDateString(row, "archivedAt"),
    createdAt: dateString(row, "createdAt"),
    updatedAt: dateString(row, "updatedAt"),
  };
}

function skillVersionFromDatafn(row: DatafnRecord, workspaceId: string): SkillVersion {
  const revision = row.revision;
  const byteSize = row.bundleByteSize;
  if (typeof revision !== "number" || typeof byteSize !== "number") {
    throw new Error("DataFn returned invalid skill version metadata");
  }
  return {
    id: requiredString(row, "id"),
    workspaceId,
    skillId: requiredString(row, "skillId"),
    revision,
    semanticVersion: optionalString(row, "semanticVersion"),
    status: requiredString(row, "status") as SkillVersionStatus,
    baseVersionId: optionalString(row, "baseVersionId"),
    proposedBump: optionalString(row, "proposedBump") as SemanticBump | null,
    source: requiredString(row, "source") as SkillVersion["source"],
    digest: requiredString(row, "contentDigest") as `sha256:${string}`,
    byteSize,
    manifest: recordValue(row, "manifest") as unknown as SkillBundleManifest,
    learningMetadata: recordValue(row, "learningMetadata") as
      LearningMetadata | Readonly<Record<string, never>>,
    amendmentOperations: arrayValue(
      row,
      "amendmentOperations",
    ) as SkillVersion["amendmentOperations"],
    callerDeclaration: recordValue(row, "callerDeclaration") as
      CallerDeclaration | Readonly<Record<string, never>>,
    policyDecision: recordValue(row, "policyDecision") as
      AmendmentPolicyDecision | Readonly<Record<string, never>>,
    changeSummary: requiredString(row, "changeSummary"),
    createdByActorType: requiredString(
      row,
      "createdByActorType",
    ) as SkillVersion["createdByActorType"],
    createdByActorId: requiredString(row, "createdByActorId"),
    createdByAgent: optionalString(row, "createdByAgent"),
    createdByModel: optionalString(row, "createdByModel"),
    createdForUserId: optionalString(row, "createdForUserId"),
    publishedAt: optionalDateString(row, "publishedAt"),
    createdAt: dateString(row, "createdAt"),
  };
}

function archiveFilters(archive: SkillArchiveFilter): Record<string, unknown> {
  if (archive === "active") return { archivedAt: { is_null: true } };
  if (archive === "archived") return { archivedAt: { is_not_null: true } };
  return {};
}

function encodeCursor(cursor: unknown, scope: string): string | null {
  if (!cursor) return null;
  const bytes = new TextEncoder().encode(
    JSON.stringify({ version: 1, scope, boundary: cursor }),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function cursorError(code = "CURSOR_INVALID"): SkillplaneApiError {
  return new SkillplaneApiError(400, {
    code,
    message:
      code === "CURSOR_FILTER_MISMATCH"
        ? "Skill cursor filters do not match"
        : "Skill cursor is invalid",
    requestId: "",
  });
}

function decodeCursor(cursor: string, scope: string): unknown {
  let value: unknown;
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    value = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0),
      ),
    );
  } catch {
    throw cursorError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw cursorError();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.scope !== "string" || !record.boundary)
    throw cursorError();
  if (record.scope !== scope) throw cursorError("CURSOR_FILTER_MISMATCH");
  return record.boundary;
}

function datafnBoundary(value: unknown): {
  readonly after?: Record<string, unknown>;
  readonly before?: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw cursorError();
  const record = value as Record<string, unknown>;
  const key = record.after !== undefined ? "after" : "before";
  const boundary = record[key];
  if (
    !boundary ||
    typeof boundary !== "object" ||
    Array.isArray(boundary) ||
    (record.after !== undefined && record.before !== undefined)
  )
    throw cursorError();
  return { [key]: boundary as Record<string, unknown> };
}

function notFound(): SkillplaneApiError {
  return new SkillplaneApiError(404, {
    code: "SKILL_NOT_FOUND",
    message: "Skill was not found",
    requestId: "",
  });
}

export async function listSkillsWithDatafn(options: {
  readonly workspaceId: string;
  readonly query?: string;
  readonly visibility?: readonly SkillVisibility[];
  readonly archive?: SkillArchiveFilter;
  readonly cursor?: string | null;
  readonly limit?: number;
}): Promise<SkillPage> {
  const query = options.query?.trim().replace(/\s+/g, " ") ?? "";
  const archive = options.archive ?? "active";
  const visibility = [...new Set(options.visibility ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );
  const scope = JSON.stringify({
    workspaceId: options.workspaceId,
    query,
    archive,
    visibility,
  });
  const boundary = options.cursor ? decodeCursor(options.cursor, scope) : undefined;
  if (query) {
    // Preserve the domain search index and ranking until DataFn has parity for
    // tags, published instructions, and context text.
    if (boundary !== undefined && typeof boundary !== "string") throw cursorError();
    const params = new URLSearchParams({
      q: query,
      state: archive,
      limit: String(options.limit ?? 20),
    });
    for (const value of visibility) params.append("visibility", value);
    if (typeof boundary === "string") params.set("cursor", boundary);
    const page = await apiRequest<SkillPage>(
      `/api/v1/workspaces/${encodeURIComponent(options.workspaceId)}/skills?${params}`,
      { headers: { "x-skillplane-workspace-id": options.workspaceId } },
    );
    return { ...page, nextCursor: encodeCursor(page.nextCursor, scope) };
  }
  const cursor = boundary === undefined ? undefined : datafnBoundary(boundary);
  return withWorkspaceDatafnClient(options.workspaceId, async (client) => {
    const filters: Record<string, unknown> = archiveFilters(archive);
    if (visibility.length) filters.visibility = { in: visibility };
    const result = await client.skills.query({
      select: ["*", "currentVersion.*"],
      filters,
      sort: ["-updatedAt", "id"],
      limit: options.limit ?? 20,
      ...(cursor ? { cursor } : {}),
    });
    return {
      skills: result.data.map((skill) => skillFromDatafn(skill, options.workspaceId)),
      nextCursor: encodeCursor(result.nextCursor, scope),
    };
  });
}

async function getSkillWithDatafnFilter(
  workspaceId: string,
  filters: Record<string, unknown>,
): Promise<Skill> {
  return withWorkspaceDatafnClient(workspaceId, async (client) => {
    const result = await client.skills.query({
      select: ["*", "currentVersion.*"],
      filters,
      limit: 1,
    });
    const skill = result.data.shift();
    if (!skill) throw notFound();
    return skillFromDatafn(skill, workspaceId);
  });
}

export function getSkillBySlugWithDatafn(
  workspaceId: string,
  skillSlug: string,
): Promise<Skill> {
  return getSkillWithDatafnFilter(workspaceId, { slug: skillSlug });
}

export function getSkillWithDatafn(
  workspaceId: string,
  skillId: string,
): Promise<Skill> {
  return getSkillWithDatafnFilter(workspaceId, { id: skillId });
}

export async function listSkillVersionsWithDatafn(
  workspaceId: string,
  skillId: string,
): Promise<readonly SkillVersion[]> {
  return withWorkspaceDatafnClient(workspaceId, async (client) => {
    const result = await client.skillVersions.query({
      filters: { skillId },
      sort: ["-revision"],
      limit: 100,
    });
    if (result.data.length === 0) {
      const parent = await client.skills.query({
        select: ["id"],
        filters: { id: skillId },
        limit: 1,
      });
      if (parent.data.length === 0) throw notFound();
    }
    return result.data.map((version) => skillVersionFromDatafn(version, workspaceId));
  });
}

export async function getSkillVersionWithDatafn(
  workspaceId: string,
  skillId: string,
  versionId: string,
): Promise<SkillVersion> {
  return withWorkspaceDatafnClient(workspaceId, async (client) => {
    const result = await client.skillVersions.query({
      filters: { id: versionId, skillId },
      limit: 1,
    });
    const version = result.data.shift();
    if (!version)
      throw new SkillplaneApiError(404, {
        code: "SKILL_VERSION_NOT_FOUND",
        message: "Skill version was not found",
        requestId: "",
      });
    return skillVersionFromDatafn(version, workspaceId);
  });
}
