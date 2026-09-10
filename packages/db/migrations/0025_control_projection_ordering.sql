-- skillplane:roles=control
-- Persist the newest regional workspace event applied to each public row so a
-- delayed worker cannot overwrite state established by a later event.

ALTER TABLE public_skill_projections
  ADD COLUMN projection_sequence bigint NOT NULL DEFAULT 0
    CHECK (projection_sequence >= 0);

COMMENT ON COLUMN public_skill_projections.projection_sequence IS
  'Monotonic regional outbox sequence that last established this row state.';
