export interface PublicSkillSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly visibility: "public";
  readonly currentVersionId: string;
  readonly semanticVersion: string;
  readonly digest: `sha256:${string}`;
  readonly archivedAt: null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly score: string;
}

export interface PublicSkillPage {
  readonly skills: readonly PublicSkillSummary[];
  readonly nextCursor: string | null;
}

export interface PublicSkill {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly visibility: "public";
  readonly currentPublishedVersionId: string;
  readonly currentSemanticVersion: string;
  readonly archivedAt: null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PublicSkillVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly revision: number;
  readonly semanticVersion: string;
  readonly status: "published";
  readonly baseVersionId: string | null;
  readonly proposedBump: "patch" | "minor" | "major" | null;
  readonly source: "human" | "agent_amendment" | "import";
  readonly digest: `sha256:${string}`;
  readonly byteSize: number;
  readonly manifest: {
    readonly formatVersion: 1;
    readonly digest: `sha256:${string}`;
    readonly byteSize: number;
    readonly expandedByteSize: number;
    readonly fileCount: number;
    readonly files: readonly {
      readonly path: string;
      readonly sha256: string;
      readonly byteSize: number;
      readonly mediaType: string;
    }[];
  };
  readonly changeSummary: string;
  readonly publishedAt: string;
  readonly createdAt: string;
}

export interface PublicSkillDetail {
  readonly skill: PublicSkill;
  readonly version: PublicSkillVersion;
}

export interface ApiEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta: { readonly requestId: string };
}

export interface ApiFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function publicSkillPath(workspaceSlug: string, skillSlug: string): string {
  return `/skills/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(skillSlug)}`;
}

export function publicSkillFilePath(options: {
  readonly workspaceSlug: string;
  readonly skillSlug: string;
  readonly versionId: string;
  readonly digest: string;
  readonly path: string;
}): string {
  return `/api/v1/skills/public/${encodeURIComponent(
    options.workspaceSlug,
  )}/${encodeURIComponent(options.skillSlug)}/versions/${encodeURIComponent(
    options.versionId,
  )}/${encodeURIComponent(options.digest)}/files/${encodePath(options.path)}`;
}
