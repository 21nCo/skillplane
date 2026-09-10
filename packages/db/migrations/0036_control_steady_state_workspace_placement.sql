-- skillplane:roles=combined,control
-- Once cutover is complete, new gateways may place workspaces in any declared
-- regional cell. Only the copying phase is pinned to the initial target.

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
       AND state = 'active'
       AND (
         (cutover_state = 'copying' AND region_id = target_region)
         OR (cutover_state = 'complete' AND region_id <> 'legacy')
       )
  ) INTO placement_is_valid;

  IF NOT placement_is_valid THEN
    RAISE EXCEPTION
      'workspace creation requires an active regional placement during topology cutover'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION skillplane_require_cutover_workspace_placement() IS
  'Prevents unplaced compatibility writes during cutover while allowing steady-state placement in any regional cell.';
