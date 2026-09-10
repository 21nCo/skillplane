-- skillplane:roles=combined,control
-- Serialize placement validation with topology updates and preserve every
-- current or in-flight placement region through declarative references.

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

-- Added NOT VALID so the constraint does not scan existing rows here. During a
-- populated pre-control-plane upgrade, 0023 has already remapped legacy
-- placements onto the requested initial region while workspace_regions still
-- holds only `legacy`; an immediate scan would abort the conversion before the
-- migrator reconciles the configured regions. The migrator validates these
-- constraints after seeding the declared regions.
ALTER TABLE workspace_placements
  ADD CONSTRAINT workspace_placements_region_id_fkey
  FOREIGN KEY (region_id) REFERENCES workspace_regions(region_id)
  ON UPDATE RESTRICT ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;

ALTER TABLE workspace_placements
  ADD CONSTRAINT workspace_placements_moving_to_region_id_fkey
  FOREIGN KEY (moving_to_region_id) REFERENCES workspace_regions(region_id)
  ON UPDATE RESTRICT ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;

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
