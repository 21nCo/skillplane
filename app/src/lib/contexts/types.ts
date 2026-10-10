export type ContextType =
  "repository" | "project" | "customer" | "environment" | "custom";
export type ContextArchiveFilter = "active" | "archived" | "all";

export interface SkillContext {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly type: ContextType;
  readonly externalReference: string | null;
  readonly description: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly currentKnowledgeRevisionId: string | null;
  readonly currentKnowledgeRevision: number | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContextKnowledgeRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly contextId: string;
  readonly revision: number;
  readonly baseRevisionId: string | null;
  readonly body: string;
  readonly bodyDigest: `sha256:${string}`;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly createdByActorType: "user" | "service_principal";
  readonly createdByActorId: string;
  readonly createdByAgent: string | null;
  readonly createdByModel: string | null;
  readonly createdForUserId: string | null;
  readonly createdAt: string;
}

export interface ContextNote {
  readonly id: string;
  readonly workspaceId: string;
  readonly contextId: string;
  readonly key: string;
  readonly title: string;
  readonly currentRevisionId: string;
  readonly currentRevision: number;
  readonly body: string;
  readonly bodyDigest: `sha256:${string}`;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContextNoteRevision {
  readonly id: string;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly revision: number;
  readonly baseRevisionId: string | null;
  readonly title: string;
  readonly body: string;
  readonly bodyDigest: `sha256:${string}`;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly createdByActorType: "user" | "service_principal";
  readonly createdByActorId: string;
  readonly createdByAgent: string | null;
  readonly createdByModel: string | null;
  readonly createdForUserId: string | null;
  readonly createdAt: string;
}

export interface ContextCreateResult {
  readonly context: SkillContext;
  readonly knowledge: ContextKnowledgeRevision;
}
