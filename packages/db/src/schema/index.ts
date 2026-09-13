import {
  skillVersionCompositions,
  skillVersionDependencies,
  skillVersionLifecycle,
  skillVerificationRuns,
  skillVerificationClaimResults,
  publicSkillVersionLifecycle,
} from "./composition.js";
import { authfnSchema } from "./authfn.js";
import { controlPlaneSchema, regionalInfrastructureSchema } from "./control-plane.js";
import {
  analyticsDaily,
  analyticsDailyDimensions,
  analyticsDailySummary,
  analyticsRollupRuns,
  amendmentReviews,
  apiRateLimits,
  auditEvents,
  contextKnowledgeRevisions,
  contextNoteRevisions,
  contextNotes,
  domainSchema,
  idempotencyRecords,
  publicStatsCounters,
  publicStatsProjectionCheckpoints,
  publicStatsProjectionEvents,
  servicePrincipals,
  skillContexts,
  skillVersionFiles,
  skillVersions,
  skills,
  workspaceInvitations,
  workspaceMemberships,
  workspaces,
} from "./domain.js";

export * from "./authfn.js";
export * from "./control-plane.js";
export * from "./domain.js";

const regionalCompositionSchema = {
  skill_version_compositions: skillVersionCompositions,
  skill_version_dependencies: skillVersionDependencies,
  skill_version_lifecycle: skillVersionLifecycle,
  skill_verification_runs: skillVerificationRuns,
  skill_verification_claim_results: skillVerificationClaimResults,
};

export const schema = {
  ...regionalCompositionSchema,
  public_skill_version_lifecycle: publicSkillVersionLifecycle,
  ...authfnSchema,
  ...domainSchema,
  ...controlPlaneSchema,
  ...regionalInfrastructureSchema,
};

export const globalControlSchema = {
  public_skill_version_lifecycle: publicSkillVersionLifecycle,
  ...authfnSchema,
  workspaces,
  workspace_memberships: workspaceMemberships,
  workspace_invitations: workspaceInvitations,
  service_principals: servicePrincipals,
  public_stats_counters: publicStatsCounters,
  public_stats_projection_events: publicStatsProjectionEvents,
  public_stats_projection_checkpoints: publicStatsProjectionCheckpoints,
  api_rate_limits: apiRateLimits,
  ...controlPlaneSchema,
};

export const regionalWorkspaceSchema = {
  ...regionalCompositionSchema,
  skills,
  skill_versions: skillVersions,
  skill_version_files: skillVersionFiles,
  skill_contexts: skillContexts,
  context_knowledge_revisions: contextKnowledgeRevisions,
  context_notes: contextNotes,
  context_note_revisions: contextNoteRevisions,
  amendment_reviews: amendmentReviews,
  audit_events: auditEvents,
  analytics_daily: analyticsDaily,
  analytics_daily_summary: analyticsDailySummary,
  analytics_daily_dimensions: analyticsDailyDimensions,
  analytics_rollup_runs: analyticsRollupRuns,
  idempotency_records: idempotencyRecords,
  ...regionalInfrastructureSchema,
};

export type SkillplaneSchema = typeof schema;
export type GlobalControlSchema = typeof globalControlSchema;
export type RegionalWorkspaceSchema = typeof regionalWorkspaceSchema;

export * from "./composition.js";
