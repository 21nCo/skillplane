-- skillplane:roles=combined,regional
-- An active cell retains the time at which its current ownership generation
-- began. Transactions started before that boundary must not become writers if
-- the workspace later moves back to this cell.

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
  generation_started_at timestamptz;
BEGIN
  old_workspace_id := COALESCE(
    to_jsonb(OLD) ->> 'workspace_id',
    to_jsonb(OLD) ->> '__ns',
    to_jsonb(OLD) ->> 'namespace'
  );
  new_workspace_id := COALESCE(
    to_jsonb(NEW) ->> 'workspace_id',
    to_jsonb(NEW) ->> '__ns',
    to_jsonb(NEW) ->> 'namespace'
  );
  cleanup_workspace_id := current_setting(
    'skillplane.workspace_migration_cleanup',
    true
  );

  IF TG_TABLE_NAME IN (
    'regional_projection_outbox',
    '__datafn_permission_directory_outbox'
  ) AND TG_OP IN ('UPDATE', 'DELETE') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  FOREACH affected_workspace_id IN ARRAY ARRAY[
    old_workspace_id,
    new_workspace_id
  ]
  LOOP
    CONTINUE WHEN affected_workspace_id IS NULL;
    CONTINUE WHEN cleanup_workspace_id IS NOT DISTINCT FROM affected_workspace_id;

    IF current_setting('transaction_isolation') IN ('repeatable read', 'serializable') THEN
      -- Force a unique-row conflict for snapshots older than the fence, and
      -- retain the row lock until this workspace write commits.
      INSERT INTO regional_workspace_migration_fences
        (workspace_id, source_epoch)
      VALUES (affected_workspace_id, 0)
      ON CONFLICT (workspace_id)
      DO UPDATE SET workspace_id = EXCLUDED.workspace_id
      RETURNING source_epoch, fenced_at
        INTO fence_epoch, generation_started_at;
    ELSE
      -- Every ordinary workspace write holds a shared lock on its durable
      -- fence row. The active row's timestamp is also the ownership-generation
      -- boundary, so a transaction admitted before a move-away/move-back cycle
      -- remains stale even after the row returns to its active state.
      INSERT INTO regional_workspace_migration_fences
        (workspace_id, source_epoch)
      VALUES (affected_workspace_id, 0)
      ON CONFLICT (workspace_id) DO NOTHING;

      SELECT source_epoch, fenced_at
        INTO fence_epoch, generation_started_at
        FROM regional_workspace_migration_fences
       WHERE workspace_id = affected_workspace_id
         FOR SHARE;
    END IF;

    IF COALESCE(fence_epoch, 0) > 0
       OR transaction_timestamp() < generation_started_at THEN
      RAISE EXCEPTION 'workspace writes are fenced during regional migration'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION skillplane_fence_workspace_migration_write() IS
  'Rejects fenced writes and transactions admitted before the current cell ownership generation.';
