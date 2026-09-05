-- skillplane:roles=combined,regional
-- Keep sequence allocation durable when processed outbox rows age out.

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
      RETURNING source_epoch INTO fence_epoch;
    ELSE
      -- Every ordinary workspace write holds a shared lock on its durable
      -- fence row. Raising the fence therefore waits only for pre-fence writes
      -- in this workspace, without locking tables used by other tenants.
      INSERT INTO regional_workspace_migration_fences
        (workspace_id, source_epoch)
      VALUES (affected_workspace_id, 0)
      ON CONFLICT (workspace_id) DO NOTHING;

      SELECT source_epoch INTO fence_epoch
        FROM regional_workspace_migration_fences
       WHERE workspace_id = affected_workspace_id
         FOR SHARE;
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

CREATE TABLE regional_projection_sequences (
  workspace_id text PRIMARY KEY,
  last_sequence bigint NOT NULL CHECK (last_sequence > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO regional_projection_sequences
  (workspace_id, last_sequence, updated_at)
SELECT workspace_id, max(sequence), now()
  FROM regional_projection_outbox
 GROUP BY workspace_id
ON CONFLICT (workspace_id) DO UPDATE
  SET last_sequence = GREATEST(
        regional_projection_sequences.last_sequence,
        EXCLUDED.last_sequence
      ),
      updated_at = now();

CREATE TRIGGER skillplane_fence_workspace_migration_write
BEFORE INSERT OR UPDATE OR DELETE ON regional_projection_sequences
FOR EACH ROW EXECUTE FUNCTION skillplane_fence_workspace_migration_write();

COMMENT ON TABLE regional_projection_sequences IS
  'Durable per-workspace projection sequence allocation independent of retained outbox rows.';
