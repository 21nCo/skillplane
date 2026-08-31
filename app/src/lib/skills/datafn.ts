import { SkillplaneApiError } from "$lib/api/client.js";
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

function encodeCursor(cursor: unknown): string | null {
  if (!cursor || typeof cursor !== "object") return null;
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string): {
  readonly after?: Record<string, unknown>;
  readonly before?: Record<string, unknown>;
} {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const value = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0),
      ),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (
      (record.after === undefined ||
        (record.after !== null &&
          typeof record.after === "object" &&
          !Array.isArray(record.after))) &&
      (record.before === undefined ||
        (record.before !== null &&
          typeof record.before === "object" &&
          !Array.isArray(record.before))) &&
      (record.after !== undefined || record.before !== undefined)
    ) {
      return {
        ...(record.after === undefined
          ? {}
          : { after: record.after as Record<string, unknown> }),
        ...(record.before === undefined
          ? {}
          : { before: record.before as Record<string, unknown> }),
      };
    }
  } catch {
    // Fall through to the stable public error below.
  }
  throw new SkillplaneApiError(400, {
    code: "CURSOR_INVALID",
    message: "Skill cursor is invalid",
    requestId: "",
  });
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
  return withWorkspaceDatafnClient(options.workspaceId, async (client) => {
    const filters: Record<string, unknown> = archiveFilters(
      options.archive ?? "active",
    );
    if (options.visibility?.length) {
      filters.visibility = { in: [...options.visibility] };
    }
    const result = await client.skills.query({
      select: ["*", "currentVersion.*"],
      filters,
      ...(options.query?.trim()
        ? { search: { query: options.query.trim(), prefix: true } }
        : {}),
      sort: ["-updatedAt", "id"],
      limit: options.limit ?? 20,
      ...(options.cursor ? { cursor: decodeCursor(options.cursor) } : {}),
    });
    return {
      skills: result.data.map((skill) => skillFromDatafn(skill, options.workspaceId)),
      nextCursor: encodeCursor(result.nextCursor),
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
    if (!version) throw notFound();
    return skillVersionFromDatafn(version, workspaceId);
  });
}
