-- skillplane:roles=control
-- Public projection URLs are denormalized, so every workspace slug mutation
-- must update the global projection in the same database transaction.

CREATE OR REPLACE FUNCTION skillplane_sync_public_projection_workspace_slug()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public_skill_projections
     SET workspace_slug = NEW.slug,
         updated_at = now()
   WHERE workspace_id = NEW.id
     AND workspace_slug IS DISTINCT FROM NEW.slug;
  RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_sync_public_projection_slug
AFTER UPDATE OF slug ON workspaces
FOR EACH ROW
WHEN (OLD.slug IS DISTINCT FROM NEW.slug)
EXECUTE FUNCTION skillplane_sync_public_projection_workspace_slug();

COMMENT ON FUNCTION skillplane_sync_public_projection_workspace_slug() IS
  'Keeps canonical public skill URLs synchronized with workspace slug changes.';
