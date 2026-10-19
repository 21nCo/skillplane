-- Reverses 0054_regional_artifact_kind.sql. Run it only after instructions
-- artifacts are removed (without the column they would read as skills) and the
-- code is rolled back, because code from 0054 onward reads skills.kind.
-- One transaction keeps the guard atomic with the schema change under any
-- runner, including psql -f without ON_ERROR_STOP: once the guard raises, every
-- later statement fails and COMMIT rolls back. The lock stops a concurrent
-- instructions insert from landing between the check and the drop.
BEGIN;
LOCK TABLE skills IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM skills WHERE kind <> 'skill') THEN
    RAISE EXCEPTION 'instructions artifacts exist; remove them before rollback';
  END IF;
END $$;
ALTER TABLE skills
  DROP CONSTRAINT skills_instructions_visibility,
  DROP CONSTRAINT skills_kind,
  DROP COLUMN kind;
-- Restore the 0019 trigger body, which counts every successful retrieval.
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
        IF NEW.action = 'skill_retrieve' AND NEW.outcome = 'success' THEN
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
DELETE FROM skillplane_schema_migrations WHERE id = '0054_regional_artifact_kind.sql';
COMMIT;
