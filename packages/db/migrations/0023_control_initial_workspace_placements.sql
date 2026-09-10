-- skillplane:roles=control
-- Move compatibility-era placements onto a cell that is actually declared by
-- the topology before the public gateways can route traffic.

DO $$
DECLARE
  initial_region text := nullif(
    current_setting('skillplane.initial_workspace_region', true),
    ''
  );
BEGIN
  IF initial_region IS NULL THEN
    RAISE EXCEPTION 'initial workspace region is required for control migration'
      USING ERRCODE = '22023';
  END IF;

  UPDATE workspace_placements
     SET region_id = initial_region,
         updated_at = now()
   WHERE region_id = 'legacy';
END;
$$;

COMMENT ON COLUMN workspace_placements.region_id IS
  'Declared topology cell that owns the workspace; legacy is compatibility-mode only.';
