-- skillplane:roles=combined,control
-- Keep compatibility writers from recreating regional state after a workspace
-- has been copied to its declared cell but before the control database is
-- physically pruned.

CREATE TABLE topology_cutover_state (
  id text PRIMARY KEY,
  state text NOT NULL,
  target_region_id text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topology_cutover_state_valid
    CHECK (state IN ('inactive', 'copying', 'complete')),
  CONSTRAINT topology_cutover_target_required CHECK (
    (state = 'inactive') OR target_region_id IS NOT NULL
  )
);

INSERT INTO topology_cutover_state (id, state)
VALUES ('legacy-to-cells', 'inactive')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION skillplane_fence_legacy_workspace_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_workspace_id text;
  cutover_state text;
  placement_region text;
  placement_state text;
BEGIN
  affected_workspace_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.workspace_id
    ELSE NEW.workspace_id
  END;
  SELECT state INTO cutover_state
    FROM topology_cutover_state
   WHERE id = 'legacy-to-cells';
  IF cutover_state IS NULL OR cutover_state = 'inactive' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT region_id, state
    INTO placement_region, placement_state
    FROM workspace_placements
   WHERE workspace_id = affected_workspace_id;
  IF placement_region IS DISTINCT FROM 'legacy'
     OR placement_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'legacy workspace writes are fenced during topology cutover'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'skills',
    'skill_versions',
    'skill_version_files',
    'skill_contexts',
    'context_knowledge_revisions',
    'context_notes',
    'context_note_revisions',
    'amendment_reviews',
    'audit_events',
    'analytics_daily',
    'analytics_daily_summary',
    'analytics_daily_dimensions',
    'analytics_rollup_runs',
    'idempotency_records',
    'regional_projection_outbox'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION skillplane_fence_legacy_workspace_write()',
      'fence_legacy_workspace_write_' || table_name,
      table_name
    );
  END LOOP;
END;
$$;

COMMENT ON TABLE topology_cutover_state IS
  'Durable, resumable guard for combined-database conversion into control plus regional cells.';
