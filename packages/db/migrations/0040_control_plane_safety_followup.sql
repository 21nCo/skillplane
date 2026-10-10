-- skillplane:roles=combined,control
-- Enforce declared placement regions at transaction boundaries and repair
-- projection heads without allowing a stale backfill to win a race.

CREATE OR REPLACE FUNCTION skillplane_require_declared_placement_region()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  placement_region text;
BEGIN
  placement_region := NEW.region_id;
  IF NOT EXISTS (
    SELECT 1
      FROM workspace_regions
     WHERE region_id = placement_region
       AND enabled
  ) THEN
    RAISE EXCEPTION 'workspace placement requires a declared enabled region'
      USING ERRCODE = '55000';
  END IF;
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
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM workspace_regions
     WHERE region_id = NEW.region_id
       AND enabled
  ) AND EXISTS (
    SELECT 1
      FROM workspace_placements
     WHERE region_id = NEW.region_id
  ) THEN
    RAISE EXCEPTION 'a region with workspace placements must remain enabled'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_regions_protect_placements
  ON workspace_regions;
CREATE CONSTRAINT TRIGGER workspace_regions_protect_placements
AFTER INSERT OR UPDATE ON workspace_regions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION skillplane_protect_placed_workspace_region();

INSERT INTO public_skill_projection_heads
  (workspace_id, skill_id, current_version_id, state, projection_sequence, updated_at)
SELECT workspace_id, skill_id,
       COALESCE(document->'skill'->>'currentPublishedVersionId', version_id),
       state, projection_sequence, now()
  FROM (
    SELECT DISTINCT ON (workspace_id, skill_id) *
      FROM public_skill_projections
     ORDER BY workspace_id, skill_id, projection_sequence DESC,
              CASE
                WHEN document->'version'->>'revision' ~ '^[0-9]+$'
                THEN (document->'version'->>'revision')::bigint
                ELSE 0
              END DESC,
              published_at DESC, version_id ASC
  ) AS current_projection
ON CONFLICT (workspace_id, skill_id)
DO UPDATE SET current_version_id = EXCLUDED.current_version_id,
              state = EXCLUDED.state,
              projection_sequence = EXCLUDED.projection_sequence,
              updated_at = now()
WHERE public_skill_projection_heads.projection_sequence <=
      EXCLUDED.projection_sequence;
