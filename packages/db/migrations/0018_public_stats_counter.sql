CREATE TABLE public_stats_counters (
  id text PRIMARY KEY,
  agent_skill_uses numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_stats_counters_global_id CHECK (id = 'global'),
  CONSTRAINT public_stats_counters_agent_skill_uses_nonnegative
    CHECK (agent_skill_uses >= 0)
);

LOCK TABLE audit_events IN SHARE ROW EXCLUSIVE MODE;
SET LOCAL TIME ZONE 'UTC';

WITH rolled_by_day AS (
  SELECT workspace_id, day,
         sum(GREATEST(event_count - failure_count, 0)) AS total
    FROM analytics_daily_dimensions
   WHERE skill_id = ''
     AND dimension_type = 'tool'
     AND dimension_value = 'skill_retrieve'
   GROUP BY workspace_id, day
),
raw_by_day AS (
  SELECT workspace_id, occurred_at::date AS day, count(*) AS total
    FROM audit_events
   WHERE action = 'skill_retrieve'
     AND outcome = 'success'
   GROUP BY workspace_id, occurred_at::date
),
reconciled_by_day AS (
  SELECT COALESCE(rolled.workspace_id, raw.workspace_id) AS workspace_id,
         COALESCE(rolled.day, raw.day) AS day,
         GREATEST(COALESCE(rolled.total, 0), COALESCE(raw.total, 0)) AS total
    FROM rolled_by_day rolled
    FULL OUTER JOIN raw_by_day raw
      ON raw.workspace_id = rolled.workspace_id
     AND raw.day = rolled.day
)
INSERT INTO public_stats_counters (id, agent_skill_uses)
SELECT 'global', COALESCE(sum(total), 0)
  FROM reconciled_by_day;

CREATE OR REPLACE FUNCTION skillplane_increment_public_agent_skill_uses()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action = 'skill_retrieve' AND NEW.outcome = 'success' THEN
    UPDATE public_stats_counters
       SET agent_skill_uses = agent_skill_uses + 1,
           updated_at = now()
     WHERE id = 'global';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_public_stats_counter_insert
  AFTER INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION skillplane_increment_public_agent_skill_uses();

COMMENT ON TABLE public_stats_counters IS
  'Materialized monotonic public counters that remain exact after audit retention.';
