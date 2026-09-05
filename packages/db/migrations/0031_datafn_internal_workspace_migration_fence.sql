-- skillplane:roles=combined,regional
-- DataFn resource rows use __ns, while its internal state tables use namespace.

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
