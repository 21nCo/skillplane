ALTER TABLE audit_events
  ADD COLUMN retention_class text NOT NULL DEFAULT 'permanent';

UPDATE audit_events
   SET retention_class = 'detailed_read_90d'
 WHERE metadata->>'retentionClass' = 'detailed_read_90d';

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_retention_class
  CHECK (retention_class IN ('detailed_read_90d', 'permanent'));

CREATE INDEX audit_events_retention_idx
  ON audit_events (retention_class, occurred_at, id);
CREATE INDEX audit_events_workspace_filters_idx
  ON audit_events (
    workspace_id,
    action,
    outcome,
    occurred_at DESC,
    id DESC
  );
CREATE INDEX audit_events_workspace_skill_time_idx
  ON audit_events (
    workspace_id,
    (metadata->>'skillId'),
    occurred_at DESC,
    id DESC
  );
CREATE INDEX audit_events_workspace_context_time_idx
  ON audit_events (workspace_id, context_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_workspace_agent_model_idx
  ON audit_events (workspace_id, agent, model, occurred_at DESC, id DESC);

DROP TRIGGER audit_events_immutable ON audit_events;

CREATE OR REPLACE FUNCTION skillplane_protect_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('skillplane.audit_retention_job', true) = 'enabled'
     AND OLD.retention_class = 'detailed_read_90d'
     AND OLD.occurred_at < now() - interval '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events rows are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION skillplane_protect_audit_event();

CREATE OR REPLACE FUNCTION skillplane_validate_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  serialized text := NEW.metadata::text;
BEGIN
  IF serialized ~* '"(prompt|skillbody|body|otp|email|token|secret|password|authorization|cookie)"[[:space:]]*:'
     OR serialized ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
     OR serialized ~* '(bearer[[:space:]]+[A-Z0-9._~+/-]+=*|sps_[A-Z0-9_-]{12,})' THEN
    RAISE EXCEPTION 'audit metadata contains a prohibited sensitive value'
      USING ERRCODE = '23514',
            CONSTRAINT = 'audit_events_sensitive_metadata';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_validate_insert
  BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION skillplane_validate_audit_event();

CREATE TABLE analytics_daily_summary (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day date NOT NULL,
  skill_id text NOT NULL DEFAULT '',
  event_count bigint NOT NULL DEFAULT 0,
  retrieval_count bigint NOT NULL DEFAULT 0,
  amendment_count bigint NOT NULL DEFAULT 0,
  approval_count bigint NOT NULL DEFAULT 0,
  context_write_count bigint NOT NULL DEFAULT 0,
  failure_count bigint NOT NULL DEFAULT 0,
  unique_principal_count bigint NOT NULL DEFAULT 0,
  unique_agent_count bigint NOT NULL DEFAULT 0,
  unique_model_count bigint NOT NULL DEFAULT 0,
  latency_p50_ms double precision,
  latency_p95_ms double precision,
  current_version_retrieval_count bigint NOT NULL DEFAULT 0,
  versioned_retrieval_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_daily_summary_pk
    PRIMARY KEY (workspace_id, day, skill_id),
  CONSTRAINT analytics_daily_summary_counts_nonnegative CHECK (
    event_count >= 0
    AND retrieval_count >= 0
    AND amendment_count >= 0
    AND approval_count >= 0
    AND context_write_count >= 0
    AND failure_count >= 0
    AND unique_principal_count >= 0
    AND unique_agent_count >= 0
    AND unique_model_count >= 0
    AND current_version_retrieval_count >= 0
    AND versioned_retrieval_count >= 0
  ),
  CONSTRAINT analytics_daily_summary_adoption_valid CHECK (
    current_version_retrieval_count <= versioned_retrieval_count
  )
);
CREATE INDEX analytics_daily_summary_workspace_day_idx
  ON analytics_daily_summary (workspace_id, day DESC, skill_id);

CREATE TABLE analytics_daily_dimensions (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day date NOT NULL,
  skill_id text NOT NULL DEFAULT '',
  dimension_type text NOT NULL,
  dimension_value text NOT NULL,
  event_count bigint NOT NULL DEFAULT 0,
  failure_count bigint NOT NULL DEFAULT 0,
  unique_principal_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_daily_dimensions_pk PRIMARY KEY (
    workspace_id,
    day,
    skill_id,
    dimension_type,
    dimension_value
  ),
  CONSTRAINT analytics_daily_dimensions_type CHECK (
    dimension_type IN ('agent', 'model', 'context', 'tool', 'outcome', 'version')
  ),
  CONSTRAINT analytics_daily_dimensions_counts_nonnegative CHECK (
    event_count >= 0
    AND failure_count >= 0
    AND unique_principal_count >= 0
  )
);
CREATE INDEX analytics_daily_dimensions_lookup_idx
  ON analytics_daily_dimensions (
    workspace_id,
    dimension_type,
    day DESC,
    skill_id,
    event_count DESC
  );

CREATE TABLE analytics_rollup_runs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day date NOT NULL,
  source_event_count bigint NOT NULL,
  source_latest_event_at timestamptz,
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_rollup_runs_pk PRIMARY KEY (workspace_id, day),
  CONSTRAINT analytics_rollup_runs_count_nonnegative
    CHECK (source_event_count >= 0)
);
CREATE INDEX analytics_rollup_runs_completed_idx
  ON analytics_rollup_runs (completed_at DESC);

COMMENT ON COLUMN audit_events.retention_class IS
  'Only detailed_read_90d events are eligible for the guarded retention job. All security and mutation history is permanent.';
COMMENT ON TABLE analytics_daily_summary IS
  'Rebuildable UTC daily workspace and skill metrics derived from the authoritative audit ledger.';
COMMENT ON TABLE analytics_daily_dimensions IS
  'Rebuildable UTC daily declared-agent, model, context, tool, outcome, and version dimensions.';
COMMENT ON TABLE analytics_rollup_runs IS
  'Idempotent rollup completion markers and source watermarks.';
