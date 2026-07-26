import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  contextKnowledgeMutationOutputSchema,
  contextKnowledgeUpdateInputSchema,
  contextGetInputSchema,
  contextGetOutputSchema,
  contextNoteMutationOutputSchema,
  contextNoteUpsertInputSchema,
  contextNotesListInputSchema,
  contextNotesListOutputSchema,
  skillAmendInputSchema,
  skillAmendOutputSchema,
  skillAssetRetrieveInputSchema,
  skillAssetRetrieveOutputSchema,
  skillRetrieveInputSchema,
  skillRetrieveOutputSchema,
  skillsSearchInputSchema,
  skillsSearchOutputSchema,
  skillVersionsListInputSchema,
  skillVersionsListOutputSchema,
} from "@skillplane/mcp-schema";
import { skillAmend } from "./tools/amend.js";
import { skillAssetRetrieve } from "./tools/assets.js";
import {
  contextKnowledgeUpdate,
  contextNoteUpsert,
} from "./tools/context-mutations.js";
import { contextGet, contextNotesList } from "./tools/contexts.js";
import { skillRetrieve } from "./tools/retrieve.js";
import { skillsSearch } from "./tools/search.js";
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
        "Search and retrieve versioned Skillplane skills and their authorized context knowledge. All caller identity fields are declared metadata; authentication remains server-derived.",
    },
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
