-- skillplane:roles=control

ALTER TABLE public_stats_counters
  ADD COLUMN total_skills numeric NOT NULL DEFAULT 0,
  ADD CONSTRAINT public_stats_counters_total_skills_nonnegative
    CHECK (total_skills >= 0);

INSERT INTO public_stats_counters (id, agent_skill_uses, total_skills, updated_at)
SELECT workspace_id, 0, count(*)::numeric, now()
  FROM skills
 WHERE archived_at IS NULL
 GROUP BY workspace_id
ON CONFLICT (id) DO UPDATE
  SET total_skills = EXCLUDED.total_skills,
      updated_at = now();

CREATE TABLE public_stats_projection_events (
  event_id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL
    CHECK (event_type IN (
      'public_stats.agent_skill_used',
      'public_stats.skill_count_changed'
    )),
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX public_stats_projection_workspace_time_idx
  ON public_stats_projection_events(workspace_id, applied_at);

COMMENT ON TABLE public_stats_projection_events IS
  'Global idempotency ledger for regional public-stat projection events.';
