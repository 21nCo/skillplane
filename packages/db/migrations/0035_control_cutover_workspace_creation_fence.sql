-- skillplane:roles=combined,control
-- Serialize workspace creation with the legacy-to-cells completion fence.
-- Current gateways insert the workspace and its target placement in one
-- transaction; compatibility workers that omit the placement are rejected.

CREATE OR REPLACE FUNCTION skillplane_require_cutover_workspace_placement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cutover_state text;
  target_region text;
  placement_is_valid boolean;
BEGIN
  SELECT state, target_region_id
    INTO cutover_state, target_region
    FROM topology_cutover_state
   WHERE id = 'legacy-to-cells'
   FOR SHARE;

  IF cutover_state IS NULL OR cutover_state = 'inactive' THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM workspace_placements
     WHERE workspace_id = NEW.id
       AND region_id = target_region
       AND state = 'active'
  ) INTO placement_is_valid;

  IF NOT placement_is_valid THEN
    RAISE EXCEPTION
      'workspace creation requires an active target placement during topology cutover'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER require_cutover_workspace_placement
AFTER INSERT ON workspaces
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION skillplane_require_cutover_workspace_placement();

COMMENT ON FUNCTION skillplane_require_cutover_workspace_placement() IS
  'Prevents compatibility workers from committing unplaced workspaces while topology cutover is copying or complete.';
