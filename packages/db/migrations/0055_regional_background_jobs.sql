-- skillplane:roles=combined,regional
-- Durable background jobs for one cell, kept next to the workspace data they
-- act on and drained by the cell's projection worker. Delivery is at least
-- once: the idempotency key prevents a duplicate enqueue, not a duplicate run.
-- A drainer claims a due job with FOR UPDATE SKIP LOCKED and a lease; a lease
-- that expires (worker crash or timeout) makes the job claimable again.
-- Payloads carry identifiers only, never secrets. The change is additive.
CREATE TABLE background_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT background_jobs_kind_check
    CHECK (kind ~ '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$' AND char_length(kind) <= 64),
  CONSTRAINT background_jobs_idempotency_key_check
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  -- The application limits compact JSON to 16 KiB. jsonb text adds spaces
  -- and expands exponent numbers, so this bound is only a storage backstop.
  CONSTRAINT background_jobs_payload_check
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  CONSTRAINT background_jobs_state_check
    CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'dead')),
  CONSTRAINT background_jobs_attempts_check CHECK (attempts >= 0),
  CONSTRAINT background_jobs_last_error_check CHECK (char_length(last_error) <= 2000),
  -- A job holds a lease exactly while it runs.
  CONSTRAINT background_jobs_lease_check CHECK (
    CASE WHEN state = 'running'
      THEN lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
      ELSE lease_owner IS NULL AND lease_expires_at IS NULL
    END
  ),
  CONSTRAINT background_jobs_idempotency_unique UNIQUE (workspace_id, kind, idempotency_key),
  UNIQUE (workspace_id, id)
);
-- Claimable work: due queued or retrying jobs, and running jobs whose lease
-- may have expired.
CREATE INDEX background_jobs_due_idx ON background_jobs (run_after)
  WHERE state IN ('queued', 'failed');
CREATE INDEX background_jobs_lease_idx ON background_jobs (lease_expires_at)
  WHERE state = 'running';
-- Operator listing of failed and dead jobs per workspace.
CREATE INDEX background_jobs_workspace_failed_idx
  ON background_jobs (workspace_id, updated_at DESC)
  WHERE state IN ('failed', 'dead');
CREATE TRIGGER background_jobs_migration_fence
  BEFORE INSERT OR UPDATE OR DELETE ON background_jobs
  FOR EACH ROW EXECUTE FUNCTION skillplane_fence_workspace_migration_write();
