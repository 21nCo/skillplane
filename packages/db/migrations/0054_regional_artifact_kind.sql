-- skillplane:roles=combined,regional
-- Instruction documents (AGENTS.md) share the skill version lifecycle as a
-- separate artifact kind. Existing rows become skills. The change is additive;
-- rollback/0054_regional_artifact_kind.sql reverses it before code rollback.
ALTER TABLE skills
  ADD COLUMN kind text NOT NULL DEFAULT 'skill',
  ADD CONSTRAINT skills_kind CHECK (kind IN ('skill', 'instructions')),
  ADD CONSTRAINT skills_instructions_visibility
    CHECK (kind <> 'instructions' OR visibility <> 'public');

-- Instructions are not skills, so their retrievals never count as public agent
-- skill uses. MCP marks such audit rows with metadata countMetric = false; the
-- regional projection already honors it, and the combined-database trigger
-- (dropped on finalized regional cells) must skip it too.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'audit_events_public_stats_counter_insert' AND NOT tgisinternal
  ) THEN
    EXECUTE $function$
      CREATE OR REPLACE FUNCTION skillplane_increment_public_agent_skill_uses()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $body$
      BEGIN
        IF NEW.action = 'skill_retrieve' AND NEW.outcome = 'success'
           AND (NEW.metadata ->> 'countMetric') IS DISTINCT FROM 'false' THEN
          INSERT INTO public_stats_counters (id, agent_skill_uses, updated_at)
          VALUES (NEW.workspace_id, 1, now())
          ON CONFLICT (id) DO UPDATE
            SET agent_skill_uses = public_stats_counters.agent_skill_uses + 1,
                updated_at = now();
        END IF;
        RETURN NEW;
      END;
      $body$
    $function$;
  END IF;
END
$migration$;
