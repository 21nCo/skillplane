-- skillplane:roles=combined,regional
-- Make workspace ownership generations epoch-based and keep drain bookkeeping
-- from mutating immutable outbox payloads.

ALTER TABLE regional_projection_outbox
  ADD CONSTRAINT regional_projection_outbox_sequence_positive
  CHECK (sequence > 0);

ALTER TABLE regional_workspace_migration_fences
  ADD COLUMN active_epoch bigint NOT NULL DEFAULT 1
    CHECK (active_epoch > 0);

UPDATE regional_workspace_migration_fences
   SET active_epoch = GREATEST(active_epoch, source_epoch, 1);

CREATE OR REPLACE FUNCTION skillplane_fence_workspace_migration_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_workspace_id text;
  new_workspace_id text;
  affected_workspace_id text;
  fence_epoch bigint;
  minimum_active_epoch bigint;
  routed_epoch bigint;
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

  IF TG_TABLE_NAME = 'regional_projection_outbox' AND TG_OP = 'UPDATE' THEN
    IF to_jsonb(OLD) - ARRAY['claim_token', 'claimed_at', 'attempts', 'last_error', 'processed_at']
       IS DISTINCT FROM
       to_jsonb(NEW) - ARRAY['claim_token', 'claimed_at', 'attempts', 'last_error', 'processed_at'] THEN
      RAISE EXCEPTION 'regional projection outbox payload is immutable during migration'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'regional_projection_outbox' AND TG_OP = 'DELETE' THEN
    IF OLD.processed_at IS NULL THEN
      RAISE EXCEPTION 'unprocessed regional projection events cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_TABLE_NAME = '__datafn_permission_directory_outbox' AND TG_OP = 'UPDATE' THEN
    IF to_jsonb(OLD) - ARRAY['attempts', 'last_error', 'next_attempt_at']
       IS DISTINCT FROM
       to_jsonb(NEW) - ARRAY['attempts', 'last_error', 'next_attempt_at'] THEN
      RAISE EXCEPTION 'DataFn permission outbox payload is immutable during migration'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = '__datafn_permission_directory_outbox' AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  routed_epoch := COALESCE(
    NULLIF(current_setting('skillplane.workspace_routing_epoch', true), '')::bigint,
    1
  );
  FOREACH affected_workspace_id IN ARRAY ARRAY[old_workspace_id, new_workspace_id]
  LOOP
    CONTINUE WHEN affected_workspace_id IS NULL;
    INSERT INTO regional_workspace_migration_fences
      (workspace_id, source_epoch, active_epoch)
    VALUES (affected_workspace_id, 0, 1)
    ON CONFLICT (workspace_id)
    DO UPDATE SET workspace_id = EXCLUDED.workspace_id
    RETURNING source_epoch, active_epoch
      INTO fence_epoch, minimum_active_epoch;
    IF fence_epoch > 0 OR routed_epoch < minimum_active_epoch THEN
      RAISE EXCEPTION 'workspace writes are fenced during regional migration'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION skillplane_protect_published_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published skill versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION skillplane_protect_published_file()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM skill_versions
     WHERE id IN (
       to_jsonb(OLD)->>'skill_version_id',
       to_jsonb(NEW)->>'skill_version_id'
     )
       AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'files belonging to published skill versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
