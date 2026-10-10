-- skillplane:roles=combined,regional
-- The published-row guards must pass NEW through for legitimate updates while
-- retaining OLD for legitimate deletes. Returning OLD for every operation
-- silently discarded draft-to-published and other unpublished updates.

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
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
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
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION skillplane_protect_published_version() IS
  'Permits unpublished updates and scoped migration cleanup while freezing published versions.';
COMMENT ON FUNCTION skillplane_protect_published_file() IS
  'Permits unpublished file updates and scoped migration cleanup while freezing published files.';
