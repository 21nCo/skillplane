-- skillplane:roles=combined,regional
-- Instruction documents (AGENTS.md) share the skill version lifecycle as a
-- separate artifact kind. Existing rows become skills. The change is additive;
-- rollback/0054_regional_artifact_kind.sql reverses it before code rollback.
ALTER TABLE skills
  ADD COLUMN kind text NOT NULL DEFAULT 'skill',
  ADD CONSTRAINT skills_kind CHECK (kind IN ('skill', 'instructions')),
  ADD CONSTRAINT skills_instructions_visibility
    CHECK (kind <> 'instructions' OR visibility <> 'public');
