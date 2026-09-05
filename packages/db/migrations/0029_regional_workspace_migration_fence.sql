-- skillplane:roles=combined,regional
-- Keep a namespace-scoped database fence active for the complete copy window.
-- The gateway fence stops new requests; this trigger also rejects a request
-- admitted under the old epoch that reaches DML after migration has started.

CREATE TABLE regional_workspace_migration_fences (
  workspace_id text PRIMARY KEY,
  source_epoch bigint NOT NULL CHECK (source_epoch >= 0),
  fenced_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION skillplane_fence_workspace_migration_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_workspace_id text;
  new_workspace_id text;
  affected_workspace_id text;
  cleanup_workspace_id text;
  fence_epoch bigint;
BEGIN
  old_workspace_id := COALESCE(
    to_jsonb(OLD) ->> 'workspace_id',
    to_jsonb(OLD) ->> '__ns'
  );
  new_workspace_id := COALESCE(
    to_jsonb(NEW) ->> 'workspace_id',
    to_jsonb(NEW) ->> '__ns'
  );
  cleanup_workspace_id := current_setting(
    'skillplane.workspace_migration_cleanup',
    true
  );

  FOREACH affected_workspace_id IN ARRAY ARRAY[
    old_workspace_id,
    new_workspace_id
  ]
  LOOP
    CONTINUE WHEN affected_workspace_id IS NULL;
    CONTINUE WHEN cleanup_workspace_id IS NOT DISTINCT FROM affected_workspace_id;

    IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
      -- An old snapshot cannot see a fence inserted after it began. Force a
      -- unique-row conflict instead: PostgreSQL rejects that stale snapshot
      -- with a serialization failure rather than admitting its DML.
      INSERT INTO regional_workspace_migration_fences
        (workspace_id, source_epoch)
      VALUES (affected_workspace_id, 0)
      ON CONFLICT (workspace_id)
      DO UPDATE SET workspace_id = EXCLUDED.workspace_id
      RETURNING source_epoch INTO fence_epoch;
    ELSE
      SELECT source_epoch INTO fence_epoch
        FROM regional_workspace_migration_fences
       WHERE workspace_id = affected_workspace_id;
    END IF;

    IF COALESCE(fence_epoch, 0) > 0 THEN
      RAISE EXCEPTION 'workspace writes are fenced during regional migration'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

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
      'CREATE TRIGGER skillplane_fence_workspace_migration_write '
      || 'BEFORE INSERT OR UPDATE OR DELETE ON %I '
      || 'FOR EACH ROW EXECUTE FUNCTION skillplane_fence_workspace_migration_write()',
      table_name
    );
  END LOOP;
END;
$$;

COMMENT ON TABLE regional_workspace_migration_fences IS
  'Source-cell DML fences retained until a regional workspace move activates or rolls back.';
