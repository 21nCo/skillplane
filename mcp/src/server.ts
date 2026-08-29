import {
  defineMcpFnServer,
  type McpFnObjectSchema,
  type McpFnServerInfo,
  type McpFnToolDefinition,
} from "@mcpfn/core";
import {
  contextCreateInputSchema,
  contextCreateOutputSchema,
  contextKnowledgeHistoryInputSchema,
  contextKnowledgeHistoryOutputSchema,
  contextKnowledgeMutationOutputSchema,
  contextKnowledgeUpdateInputSchema,
  contextLifecycleMutationOutputSchema,
  contextGetInputSchema,
  contextGetOutputSchema,
  contextNoteMutationOutputSchema,
  contextNoteUpsertInputSchema,
  contextNotesListInputSchema,
  contextNotesListOutputSchema,
  contextsListInputSchema,
  contextsListOutputSchema,
  contextStateMutationInputSchema,
  contextUpdateInputSchema,
  skillsListInputSchema,
  skillsListOutputSchema,
  skillAmendInputSchema,
  skillAmendOutputSchema,
  skillAssetRetrieveInputSchema,
  skillAssetRetrieveOutputSchema,
  skillRetrieveInputSchema,
  skillRetrieveOutputSchema,
  skillsSearchInputSchema,
  skillsSearchOutputSchema,
  workspacesListInputSchema,
  workspacesListOutputSchema,
  skillVersionsListInputSchema,
  skillVersionsListOutputSchema,
  skillCreateInputSchema,
  skillCreateOutputSchema,
  skillVisibilityUpdateInputSchema,
  skillStateMutationInputSchema,
  skillLifecycleMutationOutputSchema,
  skillCandidatesListInputSchema,
  skillCandidatesListOutputSchema,
  skillCandidateDecisionInputSchema,
  skillCandidateDecisionOutputSchema,
  skillAmendmentPolicyGetInputSchema,
  skillAmendmentPolicyUpdateInputSchema,
  skillAmendmentPolicyOutputSchema,
  skillVersionsDiffInputSchema,
  skillVersionsDiffOutputSchema,
} from "@skillplane/mcp-schema";
import { skillAmend } from "./tools/amend.js";
import { skillAssetRetrieve } from "./tools/assets.js";
import { skillsList, workspacesList } from "./tools/catalog.js";
import {
  contextArchive,
  contextCreate,
  contextKnowledgeHistory,
  contextRestore,
  contextsList,
  contextUpdate,
} from "./tools/context-lifecycle.js";
import {
  contextKnowledgeUpdate,
  contextNoteUpsert,
} from "./tools/context-mutations.js";
import { contextGet, contextNotesList } from "./tools/contexts.js";
import { skillRetrieve } from "./tools/retrieve.js";
import { skillsSearch } from "./tools/search.js";
import {
  skillAmendmentPolicyGet,
  skillAmendmentPolicyUpdate,
  skillArchive,
  skillCandidateApprove,
  skillCandidateReject,
  skillCandidatesList,
  skillCreate,
  skillRestore,
  skillVersionsDiff,
  skillVisibilityUpdate,
} from "./tools/skill-lifecycle.js";
import type { McpToolRuntime } from "./tools/shared.js";
import { skillVersionsList } from "./tools/versions.js";
import { z, type ZodType } from "zod";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MUTATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const SKILLPLANE_MCP_SERVER_INFO: McpFnServerInfo = {
  name: "skillplane",
  title: "Skillplane",
  version: "1.0.0",
  description:
    "Discover, retrieve, and manage versioned Skillplane skills and authorized context knowledge.",
  websiteUrl: "https://skillplane.dev",
  icons: [
    {
      src: "https://mcp.skillplane.dev/icon-192.png",
      mimeType: "image/png",
      sizes: ["192x192"],
    },
    {
      src: "https://mcp.skillplane.dev/icon-512.png",
      mimeType: "image/png",
      sizes: ["512x512"],
    },
  ],
};

type ToolAnnotations = typeof READ_ONLY_ANNOTATIONS | typeof MUTATION_ANNOTATIONS;

function objectSchema(schema: ZodType, io: "input" | "output"): McpFnObjectSchema {
  const converted = z.toJSONSchema(schema, { target: "draft-7", io });
  if (converted.type !== "object") {
    throw new TypeError("Skillplane MCP tool schemas must describe objects");
  }
  return converted as McpFnObjectSchema;
}

function tool<TInput>(options: {
  name: string;
  title: string;
  description: string;
  input: ZodType<TInput>;
  output: ZodType;
  annotations: ToolAnnotations;
  run(runtime: McpToolRuntime, input: TInput): Promise<unknown>;
}): McpFnToolDefinition<McpToolRuntime> {
  return {
    name: options.name,
    title: options.title,
    description: options.description,
    inputSchema: objectSchema(options.input, "input"),
    outputSchema: objectSchema(options.output, "output"),
    annotations: options.annotations,
    handler: async (args, runtime) =>
      (await options.run(runtime, options.input.parse(args))) as Awaited<
        ReturnType<McpFnToolDefinition<McpToolRuntime>["handler"]>
      >,
  };
}

export const skillplaneMcpDeclaration = defineMcpFnServer<McpToolRuntime>({
  info: {
    ...SKILLPLANE_MCP_SERVER_INFO,
    instructions:
      "Discover, retrieve, and manage versioned Skillplane skills and their authorized context knowledge. Start with workspaces_list, skills_list, and contexts_list when identifiers are unknown. All caller identity fields are declared metadata; authentication remains server-derived.",
  },
  transports: ["streamable-http"],
  tools: [
    tool({
      name: "workspaces_list",
      title: "List my workspaces",
      description:
        "Discover every workspace available to the authenticated OAuth user, or the single workspace bound to an agent credential, using an opaque cursor. No workspace identifier is required.",
      input: workspacesListInputSchema,
      output: workspacesListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: workspacesList,
    }),
    tool({
      name: "skills_list",
      title: "List workspace skills",
      description:
        "Enumerate authorized skills in one workspace without a search query. Includes active unpublished skill records, supports visibility and archive filters, and returns an opaque cursor until every matching skill has been listed.",
      input: skillsListInputSchema,
      output: skillsListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: skillsList,
    }),
    tool({
      name: "skills_search",
      title: "Search skills",
      description:
        "Search one workspace using authorization-filtered Postgres full-text ranking. Returns only stable skill metadata, current published version IDs, semantic versions, digests, and an opaque cursor.",
      input: skillsSearchInputSchema,
      output: skillsSearchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: skillsSearch,
    }),
    tool({
      name: "skill_retrieve",
      title: "Retrieve a skill",
      description:
        "Retrieve one exact authorized immutable skill version with its canonical manifest, verified bundle digest, SKILL.md instructions, file descriptors, and optional authorized context knowledge and active notes.",
      input: skillRetrieveInputSchema,
      output: skillRetrieveOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: skillRetrieve,
    }),
    tool({
      name: "skill_asset_retrieve",
      title: "Retrieve a skill asset",
      description:
        "Retrieve one traversal-safe file from an exact authorized skill version. Small safe content is returned as UTF-8 or base64; larger files use a five-minute bearer-bound authenticated download.",
      input: skillAssetRetrieveInputSchema,
      output: skillAssetRetrieveOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: skillAssetRetrieve,
    }),
    tool({
      name: "skill_versions_list",
      title: "List skill versions",
      description:
        "List authorized immutable skill history using an opaque filter-bound cursor. Published history is public only for public skills; candidate states require an authorized workspace role.",
      input: skillVersionsListInputSchema,
      output: skillVersionsListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: skillVersionsList,
    }),
    tool({
      name: "skill_versions_diff",
      title: "Diff skill versions",
      description:
        "Compare two exact authorized immutable skill versions by file digest, with bounded line-level text changes when safe.",
      input: skillVersionsDiffInputSchema,
      output: skillVersionsDiffOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: skillVersionsDiff,
    }),
    tool({
      name: "skill_candidates_list",
      title: "List skill candidates",
      description:
        "List authorized amendment review candidates and their immutable proposed versions using status filters and an opaque filter-bound cursor.",
      input: skillCandidatesListInputSchema,
      output: skillCandidatesListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: skillCandidatesList,
    }),
    tool({
      name: "skill_amendment_policy_get",
      title: "Get skill amendment policy",
      description:
        "Read one authorized skill's review or trusted auto-publication policy together with the skill metadata concurrency token.",
      input: skillAmendmentPolicyGetInputSchema,
      output: skillAmendmentPolicyOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: skillAmendmentPolicyGet,
    }),
    tool({
      name: "contexts_list",
      title: "List skill contexts",
      description:
        "Discover authorized active or archived contexts for one skill in deterministic latest-update order with current knowledge revision identity and an opaque filter-bound cursor.",
      input: contextsListInputSchema,
      output: contextsListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: contextsList,
    }),
    tool({
      name: "context_get",
      title: "Get skill context",
      description:
        "Read one authorized skill context with an exact current or selected immutable knowledge revision and, when requested, active shared notes.",
      input: contextGetInputSchema,
      output: contextGetOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: contextGet,
    }),
    tool({
      name: "context_knowledge_history",
      title: "List context knowledge history",
      description:
        "List immutable knowledge revisions for one authorized context with Markdown, digests, learning metadata, safe agent/model provenance, and an opaque filter-bound cursor.",
      input: contextKnowledgeHistoryInputSchema,
      output: contextKnowledgeHistoryOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: contextKnowledgeHistory,
    }),
    tool({
      name: "context_notes_list",
      title: "List context notes",
      description:
        "List authorized shared context notes in deterministic latest-update order with immutable current revision IDs, digests, Markdown bodies, archive state, and an opaque cursor.",
      input: contextNotesListInputSchema,
      output: contextNotesListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
      run: contextNotesList,
    }),
    tool({
      name: "skill_amend",
      title: "Amend a skill",
      description:
        "Create one immutable, replay-safe skill amendment from an exact current base using digest-checked add, replace, or delete operations, structured learning evidence, and the skill's review or trusted auto-publication policy.",
      input: skillAmendInputSchema,
      output: skillAmendOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: skillAmend,
    }),
    tool({
      name: "skill_create",
      title: "Create a skill",
      description:
        "Create one authorized skill and immutable published 1.0.0 version from a bounded canonical file set with caller attribution, durable audit, and replay-safe idempotency.",
      input: skillCreateInputSchema,
      output: skillCreateOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: skillCreate,
    }),
    tool({
      name: "skill_visibility_update",
      title: "Update skill visibility",
      description:
        "Change authorized skill visibility using the exact previously observed updatedAt value, durable audit, and replay-safe idempotency.",
      input: skillVisibilityUpdateInputSchema,
      output: skillLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: skillVisibilityUpdate,
    }),
    tool({
      name: "skill_archive",
      title: "Archive a skill",
      description:
        "Archive one authorized skill while preserving immutable versions and contexts, using optimistic concurrency and replay-safe idempotency.",
      input: skillStateMutationInputSchema,
      output: skillLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: skillArchive,
    }),
    tool({
      name: "skill_restore",
      title: "Restore a skill",
      description:
        "Restore one authorized archived skill using optimistic concurrency, durable audit, and replay-safe idempotency.",
      input: skillStateMutationInputSchema,
      output: skillLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: skillRestore,
    }),
    tool({
      name: "skill_candidate_approve",
      title: "Approve a skill candidate",
      description:
        "Approve one pending authorized amendment review using its exact updatedAt value, publish the immutable candidate, and record durable reviewer attribution.",
      input: skillCandidateDecisionInputSchema,
      output: skillCandidateDecisionOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: skillCandidateApprove,
    }),
    tool({
      name: "skill_candidate_reject",
      title: "Reject a skill candidate",
      description:
        "Reject one pending authorized amendment review using its exact updatedAt value, preserving its immutable candidate and recording durable reviewer attribution.",
      input: skillCandidateDecisionInputSchema,
      output: skillCandidateDecisionOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: skillCandidateReject,
    }),
    tool({
      name: "skill_amendment_policy_update",
      title: "Update skill amendment policy",
      description:
        "Replace one authorized skill's review or trusted auto-publication policy as a workspace owner using optimistic concurrency and replay-safe durable audit.",
      input: skillAmendmentPolicyUpdateInputSchema,
      output: skillAmendmentPolicyOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: skillAmendmentPolicyUpdate,
    }),
    tool({
      name: "context_create",
      title: "Create a skill context",
      description:
        "Atomically create one authorized skill context and its first immutable knowledge revision with bounded metadata, caller attribution, durable audit, and replay-safe idempotency.",
      input: contextCreateInputSchema,
      output: contextCreateOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: contextCreate,
    }),
    tool({
      name: "context_update",
      title: "Update context metadata",
      description:
        "Update authorized context metadata without changing knowledge, requiring the exact previously observed updatedAt value for optimistic concurrency and replay-safe idempotency.",
      input: contextUpdateInputSchema,
      output: contextLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: contextUpdate,
    }),
    tool({
      name: "context_archive",
      title: "Archive a context",
      description:
        "Archive one authorized context using the exact previously observed updatedAt value, durable transactional audit, and replay-safe idempotency.",
      input: contextStateMutationInputSchema,
      output: contextLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: contextArchive,
    }),
    tool({
      name: "context_restore",
      title: "Restore a context",
      description:
        "Restore one authorized archived context using the exact previously observed updatedAt value, durable transactional audit, and replay-safe idempotency.",
      input: contextStateMutationInputSchema,
      output: contextLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: contextRestore,
    }),
    tool({
      name: "context_knowledge_update",
      title: "Update context knowledge",
      description:
        "Create the next immutable shared context-knowledge revision using optimistic concurrency, bounded learning metadata, and replay-safe idempotency.",
      input: contextKnowledgeUpdateInputSchema,
      output: contextKnowledgeMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: contextKnowledgeUpdate,
    }),
    tool({
      name: "context_note_upsert",
      title: "Create or update a context note",
      description:
        "Create a shared context note at revision one or append its next immutable revision using a stable note ID, required expected revision for updates, and replay-safe idempotency.",
      input: contextNoteUpsertInputSchema,
      output: contextNoteMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
      run: contextNoteUpsert,
    }),
  ],
});

export function createSkillplaneMcpServer(runtime: McpToolRuntime) {
  return skillplaneMcpDeclaration.createServer({ context: () => runtime });
}
