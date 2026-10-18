-- Reverses 0054_regional_artifact_kind.sql. Instructions artifacts must be
-- archived or removed first: without the column they would read as skills.
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
DELETE FROM skillplane_schema_migrations WHERE id = '0054_regional_artifact_kind.sql';
