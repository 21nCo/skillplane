import { apiRequest, jsonBody } from "$lib/api/client.js";
import type {
  ContextArchiveFilter,
  ContextCreateResult,
  ContextKnowledgeRevision,
  ContextNote,
  ContextNoteRevision,
  ContextType,
  SkillContext,
} from "./types.js";

function workspaceHeaders(workspaceId: string, idempotencyKey?: string): Headers {
  const headers = new Headers({ "x-skillplane-workspace-id": workspaceId });
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return headers;
}

export async function listContexts(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly archive?: ContextArchiveFilter;
}): Promise<readonly SkillContext[]> {
  const data = await apiRequest<{ contexts: readonly SkillContext[] }>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}/contexts?state=${encodeURIComponent(
      options.archive ?? "active",
    )}`,
    { headers: workspaceHeaders(options.workspaceId) },
  );
  return data.contexts;
}

export async function getContextBySlug(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly contextSlug: string;
}): Promise<SkillContext> {
  const data = await apiRequest<{ context: SkillContext }>(
    `/api/v1/skills/${encodeURIComponent(
      options.skillId,
    )}/contexts/by-slug/${encodeURIComponent(options.contextSlug)}`,
    { headers: workspaceHeaders(options.workspaceId) },
  );
  return data.context;
}

export async function createContext(options: {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly type: ContextType;
  readonly externalReference: string | null;
  readonly description: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly knowledge: string;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}): Promise<ContextCreateResult> {
  return apiRequest<ContextCreateResult>(
    `/api/v1/skills/${encodeURIComponent(options.skillId)}/contexts`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({
        slug: options.slug,
        name: options.name,
        type: options.type,
        externalReference: options.externalReference,
        description: options.description,
        metadata: options.metadata,
        knowledge: options.knowledge,
        learningMetadata: options.learningMetadata,
      }),
    },
  );
}

export async function updateContext(options: {
  readonly workspaceId: string;
  readonly contextId: string;
  readonly patch: Readonly<{
    name?: string;
    type?: ContextType;
    externalReference?: string | null;
    description?: string;
    metadata?: Readonly<Record<string, unknown>>;
  }>;
  readonly idempotencyKey: string;
}): Promise<SkillContext> {
  const data = await apiRequest<{ context: SkillContext }>(
    `/api/v1/contexts/${encodeURIComponent(options.contextId)}`,
    {
      method: "PATCH",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody(options.patch),
    },
  );
  return data.context;
}

export async function setContextArchived(options: {
  readonly workspaceId: string;
  readonly contextId: string;
  readonly archived: boolean;
  readonly idempotencyKey: string;
}): Promise<SkillContext> {
  const data = await apiRequest<{ context: SkillContext }>(
    `/api/v1/contexts/${encodeURIComponent(options.contextId)}/${
      options.archived ? "archive" : "restore"
    }`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
    },
  );
  return data.context;
}

export async function getContextKnowledge(
  workspaceId: string,
  contextId: string,
): Promise<ContextKnowledgeRevision> {
  const data = await apiRequest<{ knowledge: ContextKnowledgeRevision }>(
    `/api/v1/contexts/${encodeURIComponent(contextId)}/knowledge`,
    { headers: workspaceHeaders(workspaceId) },
  );
  return data.knowledge;
}

export async function listKnowledgeHistory(
  workspaceId: string,
  contextId: string,
): Promise<readonly ContextKnowledgeRevision[]> {
  const data = await apiRequest<{
    revisions: readonly ContextKnowledgeRevision[];
  }>(`/api/v1/contexts/${encodeURIComponent(contextId)}/knowledge/history`, {
    headers: workspaceHeaders(workspaceId),
  });
  return data.revisions;
}

export async function updateContextKnowledge(options: {
  readonly workspaceId: string;
  readonly contextId: string;
  readonly expectedRevision: number;
  readonly knowledge: string;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}): Promise<ContextKnowledgeRevision> {
  const data = await apiRequest<{ knowledge: ContextKnowledgeRevision }>(
    `/api/v1/contexts/${encodeURIComponent(options.contextId)}/knowledge`,
    {
      method: "PUT",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({
        expectedRevision: options.expectedRevision,
        knowledge: options.knowledge,
        learningMetadata: options.learningMetadata,
      }),
    },
  );
  return data.knowledge;
}

export async function listContextNotes(options: {
  readonly workspaceId: string;
  readonly contextId: string;
  readonly archive?: ContextArchiveFilter;
}): Promise<readonly ContextNote[]> {
  const data = await apiRequest<{ notes: readonly ContextNote[] }>(
    `/api/v1/contexts/${encodeURIComponent(
      options.contextId,
    )}/notes?state=${encodeURIComponent(options.archive ?? "active")}`,
    { headers: workspaceHeaders(options.workspaceId) },
  );
  return data.notes;
}

export async function createContextNote(options: {
  readonly workspaceId: string;
  readonly contextId: string;
  readonly title: string;
  readonly body: string;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}): Promise<ContextNote> {
  const data = await apiRequest<{ note: ContextNote }>(
    `/api/v1/contexts/${encodeURIComponent(options.contextId)}/notes`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({
        title: options.title,
        body: options.body,
        learningMetadata: options.learningMetadata,
      }),
    },
  );
  return data.note;
}

export async function updateContextNote(options: {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly expectedRevision: number;
  readonly title: string;
  readonly body: string;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}): Promise<ContextNote> {
  const data = await apiRequest<{ note: ContextNote }>(
    `/api/v1/context-notes/${encodeURIComponent(options.noteId)}`,
    {
      method: "PUT",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
      ...jsonBody({
        expectedRevision: options.expectedRevision,
        title: options.title,
        body: options.body,
        learningMetadata: options.learningMetadata,
      }),
    },
  );
  return data.note;
}

export async function archiveContextNote(options: {
  readonly workspaceId: string;
  readonly noteId: string;
  readonly idempotencyKey: string;
}): Promise<ContextNote> {
  const data = await apiRequest<{ note: ContextNote }>(
    `/api/v1/context-notes/${encodeURIComponent(options.noteId)}/archive`,
    {
      method: "POST",
      headers: workspaceHeaders(options.workspaceId, options.idempotencyKey),
    },
  );
  return data.note;
}

export async function listNoteHistory(
  workspaceId: string,
  noteId: string,
): Promise<readonly ContextNoteRevision[]> {
  const data = await apiRequest<{
    revisions: readonly ContextNoteRevision[];
  }>(`/api/v1/context-notes/${encodeURIComponent(noteId)}/history`, {
    headers: workspaceHeaders(workspaceId),
  });
  return data.revisions;
}
