export const GLOBAL_CONTROL_TABLES = [
  "authfn_users",
  "authfn_sessions",
  "authfn_otp_challenges",
  "authfn_api_keys",
  "authfn_region_profiles",
  "authfn_identity_placements",
  "authfn_oauth_clients",
  "authfn_oauth_client_redirect_uris",
  "authfn_oauth_consents",
  "authfn_oauth_authorization_requests",
  "authfn_oauth_authorization_codes",
  "authfn_oauth_access_tokens",
  "authfn_oauth_refresh_tokens",
  "workspaces",
  "workspace_memberships",
  "workspace_invitations",
  "service_principals",
  "workspace_placements",
  "resource_routing_directory",
  "permission_directory_records",
  "workspace_routing_nonces",
  "public_skill_projections",
  "workspace_migration_runs",
  "topology_cutover_state",
  "control_plane_audit_events",
  "control_plane_outbox",
  "public_stats_counters",
  "public_stats_projection_events",
  "api_rate_limits",
] as const;

export const REGIONAL_WORKSPACE_TABLES = [
  "skills",
  "skill_versions",
  "skill_version_files",
  "skill_contexts",
  "context_knowledge_revisions",
  "context_notes",
  "context_note_revisions",
  "amendment_reviews",
  "audit_events",
  "analytics_daily",
  "analytics_daily_summary",
  "analytics_daily_dimensions",
  "analytics_rollup_runs",
  "idempotency_records",
  "regional_projection_outbox",
] as const;

export function assertDisjointTableOwnership(): void {
  const global = new Set<string>(GLOBAL_CONTROL_TABLES);
  const overlap = REGIONAL_WORKSPACE_TABLES.filter((table) => global.has(table));
  if (overlap.length > 0) {
    throw new Error(`TABLE_OWNERSHIP_OVERLAP:${overlap.join(",")}`);
  }
}
