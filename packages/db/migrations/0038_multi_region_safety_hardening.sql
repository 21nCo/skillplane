-- skillplane:roles=combined,control
-- Repair the remaining control-plane safety contracts without rewriting any
-- already-ledgered migration.

CREATE TABLE workspace_regions (
  region_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_regions_id_valid
    CHECK (region_id ~ '^[a-z0-9][a-z0-9-]{0,62}$')
);

INSERT INTO workspace_regions (region_id)
VALUES ('legacy')
ON CONFLICT (region_id) DO NOTHING;

DO $$
DECLARE
  pending boolean;
BEGIN
  IF to_regclass('public.regional_projection_outbox') IS NOT NULL
     AND to_regclass('public.public_skill_projections') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM regional_projection_outbox WHERE processed_at IS NULL)'
       INTO pending;
    IF pending THEN
      RAISE EXCEPTION 'regional projection outbox must be drained before enabling control ordering'
        USING ERRCODE = '55000';
    END IF;
  END IF;
END;
$$;

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
              updated_at = now();

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
  IF cutover_state IS NULL OR cutover_state = 'inactive' THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1
      FROM workspace_placements placement
      JOIN workspace_regions region
        ON region.region_id = placement.region_id AND region.enabled
     WHERE placement.workspace_id = NEW.id
       AND placement.state = 'active'
       AND (
         (cutover_state = 'copying' AND placement.region_id = target_region)
         OR (cutover_state = 'complete' AND placement.region_id <> 'legacy')
       )
  ) INTO placement_is_valid;
  IF NOT placement_is_valid THEN
    RAISE EXCEPTION 'workspace creation requires an active declared regional placement'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
