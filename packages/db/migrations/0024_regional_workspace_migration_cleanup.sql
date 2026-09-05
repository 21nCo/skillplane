-- skillplane:roles=combined,regional
-- A fenced workspace move must be able to remove only the copied target
-- namespace during its mandatory rollback drill. Ordinary application writes
-- retain the published and append-only immutability guarantees.

CREATE OR REPLACE FUNCTION skillplane_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('skillplane.workspace_migration_cleanup', true)
         = OLD.workspace_id THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION skillplane_protect_published_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('skillplane.workspace_migration_cleanup', true)
         = OLD.workspace_id THEN
    RETURN OLD;
  END IF;
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published skill versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION skillplane_protect_published_file()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('skillplane.workspace_migration_cleanup', true)
         = OLD.workspace_id THEN
    RETURN OLD;
  END IF;
  IF EXISTS (
    SELECT 1 FROM skill_versions
    WHERE id = OLD.skill_version_id AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'files belonging to published skill versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
