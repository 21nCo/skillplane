-- skillplane:roles=combined,control
-- Replace the unbounded per-event stats ledger with a durable sequence checkpoint.

CREATE TABLE public_stats_projection_checkpoints (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  fencing_epoch bigint NOT NULL CHECK (fencing_epoch > 0),
  sequence bigint NOT NULL CHECK (sequence > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public_stats_projection_events
  ADD COLUMN fencing_epoch bigint,
  ADD COLUMN sequence bigint,
  ADD CONSTRAINT public_stats_projection_events_epoch_positive
    CHECK (fencing_epoch IS NULL OR fencing_epoch > 0),
  ADD CONSTRAINT public_stats_projection_events_sequence_positive
    CHECK (sequence IS NULL OR sequence > 0);

CREATE INDEX public_stats_projection_events_retention_idx
  ON public_stats_projection_events(applied_at, event_id)
  WHERE sequence IS NOT NULL;

COMMENT ON TABLE public_stats_projection_checkpoints IS
  'Durable high-water mark for idempotent regional public-stat projections.';

COMMENT ON TABLE public_stats_projection_events IS
  'Replay-window ledger for public-stat events; null sequence rows predate checkpoints.';
