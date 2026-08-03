import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export function createSkillplaneMcpServer(runtime: McpToolRuntime): McpServer {
  const server = new McpServer(
    {
      name: "skillplane",
      title: "Skillplane",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: { listChanged: false },
      },
      instructions:
        "Discover, retrieve, and manage versioned Skillplane skills and their authorized context knowledge. Start with workspaces_list, skills_list, and contexts_list when identifiers are unknown. All caller identity fields are declared metadata; authentication remains server-derived.",
    },
  );

  server.registerTool(
    "workspaces_list",
    {
      title: "List my workspaces",
      description:
        "Discover every workspace available to the authenticated OAuth user, or the single workspace bound to an agent credential, using an opaque cursor. No workspace identifier is required.",
      inputSchema: workspacesListInputSchema,
      outputSchema: workspacesListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => workspacesList(runtime, input),
  );

  server.registerTool(
    "skills_list",
    {
      title: "List workspace skills",
      description:
        "Enumerate authorized skills in one workspace without a search query. Includes active unpublished skill records, supports visibility and archive filters, and returns an opaque cursor until every matching skill has been listed.",
      inputSchema: skillsListInputSchema,
      outputSchema: skillsListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => skillsList(runtime, input),
  );

  server.registerTool(
    "skills_search",
    {
      title: "Search skills",
      description:
        "Search one workspace using authorization-filtered Postgres full-text ranking. Returns only stable skill metadata, current published version IDs, semantic versions, digests, and an opaque cursor.",
      inputSchema: skillsSearchInputSchema,
      outputSchema: skillsSearchOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => skillsSearch(runtime, input),
  );

  server.registerTool(
    "skill_retrieve",
    {
      title: "Retrieve a skill",
      description:
        "Retrieve one exact authorized immutable skill version with its canonical manifest, verified bundle digest, SKILL.md instructions, file descriptors, and optional authorized context knowledge and active notes.",
      inputSchema: skillRetrieveInputSchema,
      outputSchema: skillRetrieveOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => skillRetrieve(runtime, input),
  );

  server.registerTool(
    "skill_asset_retrieve",
    {
      title: "Retrieve a skill asset",
      description:
        "Retrieve one traversal-safe file from an exact authorized skill version. Small safe content is returned as UTF-8 or base64; larger files use a five-minute bearer-bound authenticated download.",
      inputSchema: skillAssetRetrieveInputSchema,
      outputSchema: skillAssetRetrieveOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => skillAssetRetrieve(runtime, input),
  );

  server.registerTool(
    "skill_versions_list",
    {
      title: "List skill versions",
      description:
        "List authorized immutable skill history using an opaque filter-bound cursor. Published history is public only for public skills; candidate states require an authorized workspace role.",
      inputSchema: skillVersionsListInputSchema,
      outputSchema: skillVersionsListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => skillVersionsList(runtime, input),
  );

  server.registerTool(
    "skill_versions_diff",
    {
      title: "Diff skill versions",
      description:
        "Compare two exact authorized immutable skill versions by file digest, with bounded line-level text changes when safe.",
      inputSchema: skillVersionsDiffInputSchema,
      outputSchema: skillVersionsDiffOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => skillVersionsDiff(runtime, input),
  );

  server.registerTool(
    "skill_candidates_list",
    {
      title: "List skill candidates",
      description:
        "List authorized amendment review candidates and their immutable proposed versions using status filters and an opaque filter-bound cursor.",
      inputSchema: skillCandidatesListInputSchema,
      outputSchema: skillCandidatesListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => skillCandidatesList(runtime, input),
  );

  server.registerTool(
    "skill_amendment_policy_get",
    {
      title: "Get skill amendment policy",
      description:
        "Read one authorized skill's review or trusted auto-publication policy together with the skill metadata concurrency token.",
      inputSchema: skillAmendmentPolicyGetInputSchema,
      outputSchema: skillAmendmentPolicyOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => skillAmendmentPolicyGet(runtime, input),
  );

  server.registerTool(
    "contexts_list",
    {
      title: "List skill contexts",
      description:
        "Discover authorized active or archived contexts for one skill in deterministic latest-update order with current knowledge revision identity and an opaque filter-bound cursor.",
      inputSchema: contextsListInputSchema,
      outputSchema: contextsListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => contextsList(runtime, input),
  );

  server.registerTool(
    "context_get",
    {
      title: "Get skill context",
      description:
        "Read one authorized skill context with an exact current or selected immutable knowledge revision and, when requested, active shared notes.",
      inputSchema: contextGetInputSchema,
      outputSchema: contextGetOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => contextGet(runtime, input),
  );

  server.registerTool(
    "context_knowledge_history",
    {
      title: "List context knowledge history",
      description:
        "List immutable knowledge revisions for one authorized context with Markdown, digests, learning metadata, safe agent/model provenance, and an opaque filter-bound cursor.",
      inputSchema: contextKnowledgeHistoryInputSchema,
      outputSchema: contextKnowledgeHistoryOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => contextKnowledgeHistory(runtime, input),
  );

  server.registerTool(
    "context_notes_list",
    {
      title: "List context notes",
      description:
        "List authorized shared context notes in deterministic latest-update order with immutable current revision IDs, digests, Markdown bodies, archive state, and an opaque cursor.",
      inputSchema: contextNotesListInputSchema,
      outputSchema: contextNotesListOutputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    (input) => contextNotesList(runtime, input),
  );

  server.registerTool(
    "skill_amend",
    {
      title: "Amend a skill",
      description:
        "Create one immutable, replay-safe skill amendment from an exact current base using digest-checked add, replace, or delete operations, structured learning evidence, and the skill's review or trusted auto-publication policy.",
      inputSchema: skillAmendInputSchema,
      outputSchema: skillAmendOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => skillAmend(runtime, input),
  );

  server.registerTool(
    "skill_create",
    {
      title: "Create a skill",
      description:
        "Create one authorized skill and immutable published 1.0.0 version from a bounded canonical file set with caller attribution, durable audit, and replay-safe idempotency.",
      inputSchema: skillCreateInputSchema,
      outputSchema: skillCreateOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => skillCreate(runtime, input),
  );

  server.registerTool(
    "skill_visibility_update",
    {
      title: "Update skill visibility",
      description:
        "Change authorized skill visibility using the exact previously observed updatedAt value, durable audit, and replay-safe idempotency.",
      inputSchema: skillVisibilityUpdateInputSchema,
      outputSchema: skillLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => skillVisibilityUpdate(runtime, input),
  );

  server.registerTool(
    "skill_archive",
    {
      title: "Archive a skill",
      description:
        "Archive one authorized skill while preserving immutable versions and contexts, using optimistic concurrency and replay-safe idempotency.",
      inputSchema: skillStateMutationInputSchema,
      outputSchema: skillLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => skillArchive(runtime, input),
  );

  server.registerTool(
    "skill_restore",
    {
      title: "Restore a skill",
      description:
        "Restore one authorized archived skill using optimistic concurrency, durable audit, and replay-safe idempotency.",
      inputSchema: skillStateMutationInputSchema,
      outputSchema: skillLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => skillRestore(runtime, input),
  );

  server.registerTool(
    "skill_candidate_approve",
    {
      title: "Approve a skill candidate",
      description:
        "Approve one pending authorized amendment review using its exact updatedAt value, publish the immutable candidate, and record durable reviewer attribution.",
      inputSchema: skillCandidateDecisionInputSchema,
      outputSchema: skillCandidateDecisionOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => skillCandidateApprove(runtime, input),
  );

  server.registerTool(
    "skill_candidate_reject",
    {
      title: "Reject a skill candidate",
      description:
        "Reject one pending authorized amendment review using its exact updatedAt value, preserving its immutable candidate and recording durable reviewer attribution.",
      inputSchema: skillCandidateDecisionInputSchema,
      outputSchema: skillCandidateDecisionOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => skillCandidateReject(runtime, input),
  );

  server.registerTool(
    "skill_amendment_policy_update",
    {
      title: "Update skill amendment policy",
      description:
        "Replace one authorized skill's review or trusted auto-publication policy as a workspace owner using optimistic concurrency and replay-safe durable audit.",
      inputSchema: skillAmendmentPolicyUpdateInputSchema,
      outputSchema: skillAmendmentPolicyOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => skillAmendmentPolicyUpdate(runtime, input),
  );

  server.registerTool(
    "context_create",
    {
      title: "Create a skill context",
      description:
        "Atomically create one authorized skill context and its first immutable knowledge revision with bounded metadata, caller attribution, durable audit, and replay-safe idempotency.",
      inputSchema: contextCreateInputSchema,
      outputSchema: contextCreateOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => contextCreate(runtime, input),
  );

  server.registerTool(
    "context_update",
    {
      title: "Update context metadata",
      description:
        "Update authorized context metadata without changing knowledge, requiring the exact previously observed updatedAt value for optimistic concurrency and replay-safe idempotency.",
      inputSchema: contextUpdateInputSchema,
      outputSchema: contextLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => contextUpdate(runtime, input),
  );

  server.registerTool(
    "context_archive",
    {
      title: "Archive a context",
      description:
        "Archive one authorized context using the exact previously observed updatedAt value, durable transactional audit, and replay-safe idempotency.",
      inputSchema: contextStateMutationInputSchema,
      outputSchema: contextLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => contextArchive(runtime, input),
  );

  server.registerTool(
    "context_restore",
    {
      title: "Restore a context",
      description:
        "Restore one authorized archived context using the exact previously observed updatedAt value, durable transactional audit, and replay-safe idempotency.",
      inputSchema: contextStateMutationInputSchema,
      outputSchema: contextLifecycleMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => contextRestore(runtime, input),
  );

  server.registerTool(
    "context_knowledge_update",
    {
      title: "Update context knowledge",
      description:
        "Create the next immutable shared context-knowledge revision using optimistic concurrency, bounded learning metadata, and replay-safe idempotency.",
      inputSchema: contextKnowledgeUpdateInputSchema,
      outputSchema: contextKnowledgeMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => contextKnowledgeUpdate(runtime, input),
  );

  server.registerTool(
    "context_note_upsert",
    {
      title: "Create or update a context note",
      description:
        "Create a shared context note at revision one or append its next immutable revision using a stable note ID, required expected revision for updates, and replay-safe idempotency.",
      inputSchema: contextNoteUpsertInputSchema,
      outputSchema: contextNoteMutationOutputSchema,
      annotations: MUTATION_ANNOTATIONS,
    },
    (input) => contextNoteUpsert(runtime, input),
  );

  return server;
}
