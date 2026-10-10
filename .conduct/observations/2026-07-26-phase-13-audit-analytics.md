# PHASE_13 audit and analytics observations

- Audit writes now converge on one redacting writer; no direct audit insert
  remains in application, domain, OAuth, or MCP TypeScript outside that
  implementation.
- Private reads use 90-day detail; mutations and security decisions use
  permanent retention.
- Database triggers enforce immutable history, reject secret-like input, and
  permit deletion only for eligible detailed rows during the guarded
  retention transaction.
- Rollups are deterministic replacements, not additive counters. Replaying
  the fixed fixture day left ten retrievals and two amendments.
- Retention aggregates affected days before deletion; the fixture aggregate
  survived four deletion batches.
- Analytics reports authenticated principal counts separately from
  caller-declared agent/model dimensions.
- Workspace and skill analytics use permanent rollups and present 7/30/90-day
  ranges, p50/p95 latency, failures, adoption, daily activity, contexts, tools,
  agents, and models.
- Detailed audit is owner/admin-only. Viewer navigation omits Audit while
  leaving aggregate Analytics available.
- The explorer filters by time, skill, context, tool, outcome, declared
  agent, and declared model; pagination cursors are signed and tenant-bound.
- CSV export uses the current filters, redacts again on read, and returns
  `private, no-store`.
- Loading, empty, success, error, retry, authorization, pagination, and export
  states are implemented. No phase-owned mutation or destructive state exists
  on these read surfaces.
- Manual screenshot review covered desktop/mobile/tablet, light/dark,
  workspace/skill, successful data, and error/retry states. No clipping or
  unusable core control was observed.
- No Superfunctions worktree or source file was modified.
- No production external state was changed.
