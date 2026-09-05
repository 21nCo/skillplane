-- skillplane:roles=control

CREATE TABLE authfn_identity_placements (
  identity_key text PRIMARY KEY,
  region_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  state text NOT NULL CHECK (state IN ('active', 'moving', 'deleting', 'tombstoned')),
  moving_to_region_id text,
  previous_region_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authfn_identity_placements_move_consistent
    CHECK ((state = 'moving') = (moving_to_region_id IS NOT NULL))
);
CREATE INDEX authfn_identity_placements_region_state_idx
  ON authfn_identity_placements(region_id, state);

COMMENT ON TABLE authfn_identity_placements IS
  'Global strongly consistent AuthFn canonical-gateway identity placement directory.';
