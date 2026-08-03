import type {
  ContextSelector,
  KnowledgeSelector,
  SkillSelector,
  VersionSelector,
} from "@skillplane/mcp-schema";
import {
  McpToolError,
  type ContextNoteOutput,
  type RetrievedContext,
} from "@skillplane/mcp-schema";
import type { BundleManifest } from "@skillplane/storage";
import type { Principal } from "@skillplane/domain";
import { principalForWorkspace } from "../auth.js";
import type { McpToolRuntime, ToolExecution } from "./shared.js";

export interface ResolvedSkill {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly visibility: "private" | "workspace" | "public";
  readonly currentPublishedVersionId: string | null;
  readonly principal: Principal | null;
}

interface SkillRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly workspace_slug: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: string[];
  readonly visibility: ResolvedSkill["visibility"];
  readonly current_published_version_id: string | null;
  readonly archived_at: Date | null;
}

export interface ResolvedVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly revision: number;
  readonly semanticVersion: string | null;
  readonly state: "draft" | "pending_review" | "published" | "rejected";
  readonly source: "human" | "agent_amendment" | "import";
  readonly baseVersionId: string | null;
  readonly proposedBump: "patch" | "minor" | "major" | null;
  readonly digest: `sha256:${string}`;
  readonly objectKey: string;
  readonly byteSize: number;
  readonly manifest: BundleManifest;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly changeSummary: string;
  readonly authorType: "user" | "service_principal" | "system";
  readonly createdAt: string;
  readonly publishedAt: string | null;
}

interface VersionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly skill_id: string;
  readonly revision: number;
  readonly semantic_version: string | null;
  readonly status: ResolvedVersion["state"];
  readonly source: ResolvedVersion["source"];
  readonly base_version_id: string | null;
  readonly proposed_bump: ResolvedVersion["proposedBump"];
  readonly content_digest: `sha256:${string}`;
  readonly r2_object_key: string;
  readonly bundle_byte_size: string | number;
  readonly manifest: BundleManifest;
  readonly learning_metadata: Record<string, unknown>;
  readonly change_summary: string;
  readonly created_by_actor_type: ResolvedVersion["authorType"];
  readonly created_at: Date;
  readonly published_at: Date | null;
}

interface ContextRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly skill_id: string;
  readonly slug: string;
  readonly name: string;
  readonly context_type: RetrievedContext["type"];
  readonly external_reference: string | null;
  readonly description: string;
  readonly metadata: Record<string, unknown>;
  readonly current_knowledge_revision_id: string | null;
  readonly archived_at: Date | null;
}

interface KnowledgeRow {
  readonly id: string;
  readonly revision: number;
  readonly knowledge: string;
  readonly body_digest: `sha256:${string}`;
  readonly created_at: Date;
}

interface NoteRow {
  readonly id: string;
  readonly note_key: string;
  readonly title: string;
  readonly current_revision_id: string;
  readonly current_revision: number;
  readonly body: string;
  readonly body_digest: `sha256:${string}`;
  readonly archived_at: Date | null;
  readonly updated_at: Date;
  readonly revision_created_at: Date;
}

export async function resolveSkill(
  runtime: McpToolRuntime,
  execution: ToolExecution,
  selector: SkillSelector,
  options: {
    readonly action:
      "skills:read" | "skills:amend" | "contexts:read" | "contexts:write";
    readonly allowPublic: boolean;
    readonly includeArchived?: boolean;
  },
): Promise<ResolvedSkill> {
  const byId = "id" in selector;
  const values = byId ? [selector.id] : [selector.workspaceSlug, selector.skillSlug];
  const result = await runtime.services.database.pool.query<SkillRow>(
    `SELECT skill.id, skill.workspace_id, workspace.slug AS workspace_slug,
            skill.slug, skill.name, skill.description, skill.tags,
            skill.visibility, skill.current_published_version_id,
            skill.archived_at
       FROM skills skill
       JOIN workspaces workspace ON workspace.id = skill.workspace_id
      WHERE ${byId ? "skill.id = $1" : "workspace.slug = $1 AND skill.slug = $2"}
      LIMIT 1`,
    values,
  );
  const row = result.rows[0];
  if (!row || (row.archived_at && !options.includeArchived)) {
    throw new McpToolError("SKILL_NOT_FOUND", "The skill was not found", {
      status: 404,
    });
  }
  execution.setScope({
    workspaceId: row.workspace_id,
    resourceType: "skill",
    resourceId: row.id,
    skillId: row.id,
  });
  const canUsePublic = options.allowPublic && row.visibility === "public";
  let principal: Principal | null;
  try {
    principal = await principalForWorkspace(
      runtime.services,
      runtime.identity,
      row.workspace_id,
      options.action,
      { allowPublicWithoutMembership: canUsePublic },
    );
  } catch {
    throw new McpToolError("SKILL_NOT_FOUND", "The skill was not found", {
      status: 404,
    });
  }
  if (!principal && !canUsePublic) {
    throw new McpToolError("SKILL_NOT_FOUND", "The skill was not found", {
      status: 404,
    });
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceSlug: row.workspace_slug,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: row.tags,
    visibility: row.visibility,
    currentPublishedVersionId: row.current_published_version_id,
    principal,
  };
}

export async function resolveVersion(
  runtime: McpToolRuntime,
  execution: ToolExecution,
  skill: ResolvedSkill,
  selector: VersionSelector,
): Promise<ResolvedVersion> {
  let predicate: string;
  let value: string | number | null;
  switch (selector.selector) {
    case "current":
      predicate = "version.id = $2";
      value = skill.currentPublishedVersionId;
      break;
    case "versionId":
      predicate = "version.id = $2";
      value = selector.versionId;
      break;
    case "semanticVersion":
      predicate = "version.semantic_version = $2";
      value = selector.semanticVersion;
      break;
    case "revision":
      predicate = "version.revision = $2";
      value = selector.revision;
      break;
  }
  if (value === null) {
    throw new McpToolError(
      "SKILL_VERSION_NOT_FOUND",
      "The skill version was not found",
      { status: 404 },
    );
  }
  const result = await runtime.services.database.pool.query<VersionRow>(
    `SELECT version.id, version.workspace_id, version.skill_id,
            version.revision, version.semantic_version, version.status,
            version.source, version.base_version_id, version.proposed_bump,
            version.content_digest, version.r2_object_key,
            version.bundle_byte_size, version.manifest,
            version.learning_metadata, version.change_summary,
            version.created_by_actor_type, version.created_at,
            version.published_at
       FROM skill_versions version
      WHERE version.skill_id = $1 AND ${predicate}
      LIMIT 1`,
    [skill.id, value],
  );
  const row = result.rows[0];
  const unpublished = row?.status !== "published";
  const principalMayReadUnpublished =
    skill.principal &&
    skill.principal.role !== "viewer" &&
    (skill.principal.kind === "user" ||
      skill.principal.scopes.includes("skills:amend"));
  if (
    !row ||
    (!skill.principal && row.status !== "published") ||
    (unpublished && !principalMayReadUnpublished)
  ) {
    throw new McpToolError(
      "SKILL_VERSION_NOT_FOUND",
      "The skill version was not found",
      { status: 404 },
    );
  }
  execution.setScope({
    resourceType: "skill_version",
    resourceId: row.id,
    versionId: row.id,
    versionDigest: row.content_digest,
  });
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    skillId: row.skill_id,
    revision: row.revision,
    semanticVersion: row.semantic_version,
    state: row.status,
    source: row.source,
    baseVersionId: row.base_version_id,
    proposedBump: row.proposed_bump,
    digest: row.content_digest,
    objectKey: row.r2_object_key,
    byteSize: Number(row.bundle_byte_size),
    manifest: row.manifest,
    learningMetadata: row.learning_metadata,
    changeSummary: row.change_summary,
    authorType: row.created_by_actor_type,
    createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

export async function resolveContext(
  runtime: McpToolRuntime,
  execution: ToolExecution,
  skill: ResolvedSkill,
  selector: ContextSelector,
  options: { readonly allowArchived?: boolean } = {},
): Promise<ContextRow> {
  if (!skill.principal) {
    throw new McpToolError("CONTEXT_NOT_FOUND", "The context was not found", {
      status: 404,
    });
  }
  const byId = "id" in selector;
  const result = await runtime.services.database.pool.query<ContextRow>(
    `SELECT id, workspace_id, skill_id, slug, name, context_type,
            external_reference, description, metadata,
            current_knowledge_revision_id, archived_at
       FROM skill_contexts
      WHERE workspace_id = $1 AND skill_id = $2
        AND ${byId ? "id = $3" : "slug = $3"}
      LIMIT 1`,
    [skill.workspaceId, skill.id, byId ? selector.id : selector.slug],
  );
  const row = result.rows[0];
  if (!row || (row.archived_at && !options.allowArchived)) {
    throw new McpToolError("CONTEXT_NOT_FOUND", "The context was not found", {
      status: 404,
    });
  }
  execution.setScope({
    resourceType: "context",
    resourceId: row.id,
    contextId: row.id,
  });
  return row;
}

export async function resolveKnowledge(
  runtime: McpToolRuntime,
  context: ContextRow,
  selector: KnowledgeSelector,
): Promise<RetrievedContext["knowledge"]> {
  let predicate: string;
  let value: string | number | null;
  switch (selector.selector) {
    case "current":
      predicate = "id = $2";
      value = context.current_knowledge_revision_id;
      break;
    case "revisionId":
      predicate = "id = $2";
      value = selector.revisionId;
      break;
    case "revision":
      predicate = "revision = $2";
      value = selector.revision;
      break;
  }
  if (value === null) return null;
  const result = await runtime.services.database.pool.query<KnowledgeRow>(
    `SELECT id, revision, knowledge, body_digest, created_at
       FROM context_knowledge_revisions
      WHERE context_id = $1 AND ${predicate}
      LIMIT 1`,
    [context.id, value],
  );
  const row = result.rows[0];
  if (!row) {
    throw new McpToolError("CONTEXT_NOT_FOUND", "The context was not found", {
      status: 404,
    });
  }
  return {
    id: row.id,
    revision: row.revision,
    digest: row.body_digest,
    markdown: row.knowledge,
    createdAt: row.created_at.toISOString(),
  };
}

export function serializeNote(row: NoteRow): ContextNoteOutput {
  return {
    id: row.id,
    slug: row.note_key,
    title: row.title,
    archivedAt: row.archived_at?.toISOString() ?? null,
    currentRevision: {
      id: row.current_revision_id,
      revision: row.current_revision,
      digest: row.body_digest,
      markdown: row.body,
      createdAt: row.revision_created_at.toISOString(),
    },
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listContextNotes(
  runtime: McpToolRuntime,
  context: ContextRow,
  options: {
    readonly state: "active" | "archived" | "all";
    readonly limit: number;
    readonly boundary?: {
      readonly updatedAt: string;
      readonly id: string;
    };
  },
): Promise<{
  readonly rows: readonly NoteRow[];
  readonly hasNext: boolean;
}> {
  const result = await runtime.services.database.pool.query<NoteRow>(
    `SELECT note.id, note.note_key, note.title, note.current_revision_id,
            revision.revision AS current_revision, revision.body,
            revision.body_digest, note.archived_at, note.updated_at,
            revision.created_at AS revision_created_at
       FROM context_notes note
       JOIN context_note_revisions revision
         ON revision.id = note.current_revision_id
        AND revision.note_id = note.id
      WHERE note.context_id = $1
        AND (
          ($2::text = 'active' AND note.archived_at IS NULL)
          OR ($2::text = 'archived' AND note.archived_at IS NOT NULL)
          OR $2::text = 'all'
        )
        AND (
          $3::timestamptz IS NULL
          OR note.updated_at < $3::timestamptz
          OR (note.updated_at = $3::timestamptz AND note.id > $4::text)
        )
      ORDER BY note.updated_at DESC, note.id ASC
      LIMIT $5`,
    [
      context.id,
      options.state,
      options.boundary?.updatedAt ?? null,
      options.boundary?.id ?? null,
      options.limit + 1,
    ],
  );
  return {
    rows: result.rows.slice(0, options.limit),
    hasNext: result.rows.length > options.limit,
  };
}

export async function contextOutput(
  runtime: McpToolRuntime,
  context: ContextRow,
  options: {
    readonly knowledge: KnowledgeSelector;
    readonly includeNotes: boolean;
  },
): Promise<RetrievedContext> {
  const [knowledge, notes] = await Promise.all([
    resolveKnowledge(runtime, context, options.knowledge),
    options.includeNotes
      ? listContextNotes(runtime, context, {
          state: "active",
          limit: 500,
        })
      : Promise.resolve({ rows: [], hasNext: false }),
  ]);
  return {
    id: context.id,
    slug: context.slug,
    name: context.name,
    description: context.description,
    type: context.context_type,
    externalReference: context.external_reference,
    metadata: context.metadata,
    knowledge,
    notes: notes.rows.map(serializeNote),
  };
}
