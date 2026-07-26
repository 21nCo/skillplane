# PHASE_12 MCP mutation observations

- The official MCP client negotiated the existing `2025-11-25` protocol and
  advertised nine total tools: six read-only and three mutating.
- All mutation tools expose object-rooted input/output JSON Schema with
  `readOnlyHint=false`, `destructiveHint=false`, `idempotentHint=true`, and
  `openWorldHint=false`.
- `skill_amend` accepts exact current base ID, expected file SHA-256,
  deterministic add/replace/delete operations, complete structured learning,
  replay key, and complete caller declaration.
- `context_knowledge_update` and `context_note_upsert` preserve one shared
  document/history model. They do not create private per-agent notes.
- Conflict error details are bounded primitives and include only the current
  revision/version identifiers needed for deterministic retry.
- Context-note ownership is checked against the selected context before the
  domain update, closing same-workspace cross-context note-ID substitution.
- Organization-owned service principals can now write attributable agent
  revisions without inventing a delegated human user.
- Forced audit failure demonstrated transaction rollback for both candidate
  creation and context knowledge pointer movement. The amendment cleanup also
  restored the R2 inventory.
- No Superfunctions worktree or source file was modified.
- No production Cloudflare, Railway, Hyperdrive, R2, DNS, or email state was
  changed.
