-- SKI-13: split globally authoritative identity/routing state from regional
-- workspace data. This migration remains single-cell compatible: existing
-- workspaces are initially placed in the legacy cell and can be moved later
-- through the fenced migration protocol.

-- Cross-database references are service-validated. Regional-to-regional and
-- global-to-global foreign keys remain intact.
CREATE TABLE authfn_region_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES authfn_users(id) ON DELETE CASCADE,
  region_id text NOT NULL,
  authority text NOT NULL,
  domain text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX idx_authfn_region_profiles_region_id
  ON authfn_region_profiles(region_id);
CREATE UNIQUE INDEX idx_authfn_region_profiles_user_id
  ON authfn_region_profiles(user_id);

ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_workspace_id_fkey;
ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_created_by_user_id_fkey;
ALTER TABLE skill_versions DROP CONSTRAINT IF EXISTS skill_versions_workspace_id_fkey;
ALTER TABLE skill_version_files DROP CONSTRAINT IF EXISTS skill_version_files_workspace_id_fkey;
ALTER TABLE skill_contexts DROP CONSTRAINT IF EXISTS skill_contexts_workspace_id_fkey;
ALTER TABLE context_knowledge_revisions DROP CONSTRAINT IF EXISTS context_knowledge_revisions_workspace_id_fkey;
ALTER TABLE context_notes DROP CONSTRAINT IF EXISTS context_notes_workspace_id_fkey;
ALTER TABLE context_note_revisions DROP CONSTRAINT IF EXISTS context_note_revisions_workspace_id_fkey;
ALTER TABLE amendment_reviews DROP CONSTRAINT IF EXISTS amendment_reviews_workspace_id_fkey;
ALTER TABLE amendment_reviews DROP CONSTRAINT IF EXISTS amendment_reviews_reviewed_by_user_id_fkey;
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_workspace_id_fkey;
ALTER TABLE analytics_daily DROP CONSTRAINT IF EXISTS analytics_daily_workspace_id_fkey;
ALTER TABLE analytics_daily_summary DROP CONSTRAINT IF EXISTS analytics_daily_summary_workspace_id_fkey;
ALTER TABLE analytics_daily_dimensions DROP CONSTRAINT IF EXISTS analytics_daily_dimensions_workspace_id_fkey;
ALTER TABLE analytics_rollup_runs DROP CONSTRAINT IF EXISTS analytics_rollup_runs_workspace_id_fkey;
ALTER TABLE idempotency_records DROP CONSTRAINT IF EXISTS idempotency_records_workspace_id_fkey;

CREATE TABLE workspace_placements (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  region_id text NOT NULL,
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0),
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'moving', 'tombstoned')),
  destination_ref text,
  moving_to_region_id text,
  previous_region_id text,
  migration jsonb,
  cache_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_placements_move_target_consistent
    CHECK ((state = 'moving') = (moving_to_region_id IS NOT NULL))
);
CREATE INDEX workspace_placements_region_state_idx
  ON workspace_placements(region_id, state);

INSERT INTO workspace_placements (workspace_id, region_id, epoch, state)
SELECT id, 'legacy', 1, 'active'
FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;

CREATE TABLE resource_routing_directory (
  resource_type text NOT NULL
    CHECK (resource_type IN ('workspace', 'skill', 'skill_version', 'context', 'context_note')),
  resource_id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'tombstoned')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT resource_routing_directory_pk PRIMARY KEY (resource_type, resource_id)
);
CREATE INDEX resource_routing_workspace_idx
  ON resource_routing_directory(workspace_id, resource_type);

CREATE TABLE permission_directory_records (
  key text PRIMARY KEY,
  value text NOT NULL,
  indexes jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX permission_directory_expiry_idx
  ON permission_directory_records(expires_at);
CREATE INDEX permission_directory_indexes_gin_idx
  ON permission_directory_records USING gin(indexes jsonb_path_ops);

CREATE TABLE workspace_routing_nonces (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
CREATE INDEX workspace_routing_nonces_expiry_idx
  ON workspace_routing_nonces(expires_at);

INSERT INTO resource_routing_directory (resource_type, resource_id, workspace_id)
SELECT 'workspace', id, id FROM workspaces
UNION ALL
SELECT 'skill', id, workspace_id FROM skills
UNION ALL
SELECT 'skill_version', id, workspace_id FROM skill_versions
UNION ALL
SELECT 'context', id, workspace_id FROM skill_contexts
UNION ALL
SELECT 'context_note', id, workspace_id FROM context_notes
ON CONFLICT (resource_type, resource_id)
DO UPDATE SET workspace_id = EXCLUDED.workspace_id, state = 'active', updated_at = now();

CREATE TABLE public_skill_projections (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workspace_slug text NOT NULL,
  skill_id text NOT NULL,
  skill_slug text NOT NULL,
  version_id text NOT NULL,
  semantic_version text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  object_key text NOT NULL,
  document jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_text text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'published'
    CHECK (state IN ('published', 'unpublished')),
  published_at timestamptz NOT NULL DEFAULT now(),
  unpublished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_skill_projections_pk
    PRIMARY KEY (workspace_id, skill_id, version_id),
  CONSTRAINT public_skill_projection_slug_version_unique
    UNIQUE (workspace_slug, skill_slug, semantic_version),
  CONSTRAINT public_skill_projection_object_key_unique UNIQUE (object_key)
);
CREATE INDEX public_skill_projection_current_idx
  ON public_skill_projections(workspace_slug, skill_slug, state, published_at);
CREATE INDEX public_skill_projection_search_idx
  ON public_skill_projections USING gin(to_tsvector('english', search_text));

CREATE TABLE workspace_migration_runs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_region_id text NOT NULL,
  target_region_id text NOT NULL,
  source_epoch bigint NOT NULL,
  final_epoch bigint,
  status text NOT NULL
    CHECK (status IN ('running', 'completed', 'rolled_back', 'failed')),
  phase text NOT NULL,
  recovery_fence bigint NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_migration_regions_distinct
    CHECK (source_region_id <> target_region_id)
);
CREATE INDEX workspace_migration_workspace_started_idx
  ON workspace_migration_runs(workspace_id, started_at);
CREATE INDEX workspace_migration_status_idx
  ON workspace_migration_runs(status, updated_at);

CREATE TABLE control_plane_audit_events (
  id text PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  user_id text,
  request_id text NOT NULL,
  resource_type text,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  channel text NOT NULL
);
CREATE INDEX control_plane_audit_workspace_time_idx
  ON control_plane_audit_events(workspace_id, occurred_at);
CREATE INDEX control_plane_audit_request_idx
  ON control_plane_audit_events(request_id);

CREATE TABLE control_plane_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  sequence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  CONSTRAINT control_plane_outbox_workspace_sequence_unique
    UNIQUE (workspace_id, sequence)
);
CREATE INDEX control_plane_outbox_pending_idx
  ON control_plane_outbox(processed_at, created_at);

CREATE TABLE regional_projection_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  sequence bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  claim_token text,
  claimed_at timestamptz,
  attempts bigint NOT NULL DEFAULT 0,
  last_error text,
  processed_at timestamptz,
  CONSTRAINT regional_projection_outbox_workspace_sequence_unique
    UNIQUE (workspace_id, sequence)
);
CREATE INDEX regional_projection_outbox_pending_idx
  ON regional_projection_outbox(processed_at, claimed_at, created_at);

COMMENT ON TABLE workspace_placements IS
  'Global linearizable workspace placement directory; cells must fence writes by epoch.';
COMMENT ON TABLE resource_routing_directory IS
  'Global resource-to-workspace routing projection; not a permission authority.';
COMMENT ON TABLE permission_directory_records IS
  'Global DataFn permission projection; workspace placement remains authoritative elsewhere.';
COMMENT ON TABLE public_skill_projections IS
  'Global metadata for digest-verified immutable public bundle copies.';
COMMENT ON TABLE control_plane_audit_events IS
  'Global audit trail for identity, membership, placement, migration, and projection changes.';
COMMENT ON TABLE regional_projection_outbox IS
  'Regional events awaiting idempotent projection into the global control plane.';
