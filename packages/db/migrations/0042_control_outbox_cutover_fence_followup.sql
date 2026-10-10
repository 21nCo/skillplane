-- skillplane:roles=combined,control
-- Let the regional projection drain acknowledge and remove completed rows
-- after the legacy workspace cutover fence becomes active.

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
   WHERE id = 'legacy-to-cells';
  IF cutover_state IS NULL OR cutover_state = 'inactive' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT region_id, state
    INTO placement_region, placement_state
    FROM workspace_placements
   WHERE workspace_id = affected_workspace_id;
  IF placement_region IS DISTINCT FROM 'legacy'
     OR placement_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'legacy workspace writes are fenced during topology cutover'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
