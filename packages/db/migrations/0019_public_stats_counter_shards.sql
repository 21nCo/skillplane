ALTER TABLE public_stats_counters
  DROP CONSTRAINT public_stats_counters_global_id;

COMMENT ON COLUMN public_stats_counters.id IS
  'Counter shard identifier. The global row is the migration baseline; workspace IDs receive new usage.';

CREATE OR REPLACE FUNCTION skillplane_increment_public_agent_skill_uses()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action = 'skill_retrieve' AND NEW.outcome = 'success' THEN
    INSERT INTO public_stats_counters (id, agent_skill_uses, updated_at)
    VALUES (NEW.workspace_id, 1, now())
    ON CONFLICT (id) DO UPDATE
      SET agent_skill_uses = public_stats_counters.agent_skill_uses + 1,
          updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON TABLE public_stats_counters IS
  'Materialized monotonic public counters sharded by workspace, plus the pre-sharding global baseline.';
