-- skillplane:roles=combined,control
-- Reapply final trigger contracts after out-of-order historical repairs and
-- serialize legacy writes with both cutover and placement transitions.

CREATE OR REPLACE FUNCTION skillplane_require_declared_placement_region()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  placement_region text;
BEGIN
  FOR placement_region IN
    SELECT DISTINCT region_id
      FROM unnest(ARRAY[NEW.region_id, NEW.moving_to_region_id]) AS regions(region_id)
     WHERE region_id IS NOT NULL
     ORDER BY region_id
  LOOP
    PERFORM 1
      FROM workspace_regions
     WHERE region_id = placement_region
       AND enabled
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'workspace placement requires declared enabled current and moving regions'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_placements_declared_region
  ON workspace_placements;
CREATE CONSTRAINT TRIGGER workspace_placements_declared_region
AFTER INSERT OR UPDATE ON workspace_placements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION skillplane_require_declared_placement_region();

CREATE OR REPLACE FUNCTION skillplane_protect_placed_workspace_region()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  protected_region text;
BEGIN
  protected_region := OLD.region_id;
  IF TG_OP = 'UPDATE'
     AND NEW.region_id = OLD.region_id
     AND NEW.enabled THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM workspace_placements
     WHERE region_id = protected_region
        OR moving_to_region_id = protected_region
  ) THEN
    RAISE EXCEPTION
      'a current or moving workspace placement region cannot be disabled, renamed, or deleted'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_regions_protect_placements
  ON workspace_regions;
CREATE CONSTRAINT TRIGGER workspace_regions_protect_placements
AFTER UPDATE OR DELETE ON workspace_regions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION skillplane_protect_placed_workspace_region();

CREATE OR REPLACE FUNCTION skillplane_fence_legacy_workspace_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_workspace_id text;
  cutover_state text;
  placement_region text;
  placement_state text;
BEGIN
  IF TG_TABLE_NAME = 'regional_projection_outbox' AND TG_OP = 'UPDATE' THEN
    IF to_jsonb(OLD) - ARRAY['claim_token', 'claimed_at', 'attempts', 'last_error', 'processed_at']
       IS DISTINCT FROM
       to_jsonb(NEW) - ARRAY['claim_token', 'claimed_at', 'attempts', 'last_error', 'processed_at'] THEN
      RAISE EXCEPTION 'regional projection outbox payload is immutable during cutover'
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

  affected_workspace_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.workspace_id
    ELSE NEW.workspace_id
  END;
  SELECT state INTO cutover_state
    FROM topology_cutover_state
   WHERE id = 'legacy-to-cells'
   FOR SHARE;
  IF cutover_state IS NULL OR cutover_state = 'inactive' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT region_id, state
    INTO placement_region, placement_state
    FROM workspace_placements
   WHERE workspace_id = affected_workspace_id
   FOR SHARE;
  IF placement_region IS DISTINCT FROM 'legacy'
     OR placement_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'legacy workspace writes are fenced during topology cutover'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
