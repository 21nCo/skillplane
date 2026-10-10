ALTER TABLE skills
  ADD CONSTRAINT skills_current_version_tenant_fk
  FOREIGN KEY (workspace_id, current_published_version_id)
  REFERENCES skill_versions(workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE skill_contexts
  ADD CONSTRAINT skill_contexts_current_knowledge_tenant_fk
  FOREIGN KEY (workspace_id, current_knowledge_revision_id)
  REFERENCES context_knowledge_revisions(workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE context_notes
  ADD CONSTRAINT context_notes_current_revision_tenant_fk
  FOREIGN KEY (workspace_id, current_revision_id)
  REFERENCES context_note_revisions(workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION skillplane_skill_search_document(
  skill_name text,
  skill_description text,
  skill_tags text[]
)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN to_tsvector(
  'simple',
  coalesce(skill_name, '') || ' ' || coalesce(skill_description, '') || ' ' ||
  coalesce(array_to_string(skill_tags, ' '), '')
);

CREATE INDEX skills_search_idx ON skills USING gin (
  skillplane_skill_search_document(name, description, tags)
);

CREATE OR REPLACE FUNCTION skillplane_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER context_knowledge_revisions_immutable
  BEFORE UPDATE OR DELETE ON context_knowledge_revisions
  FOR EACH ROW EXECUTE FUNCTION skillplane_reject_mutation();
CREATE TRIGGER context_note_revisions_immutable
  BEFORE UPDATE OR DELETE ON context_note_revisions
  FOR EACH ROW EXECUTE FUNCTION skillplane_reject_mutation();
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION skillplane_reject_mutation();

CREATE OR REPLACE FUNCTION skillplane_protect_published_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published skill versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER skill_versions_protect_published
  BEFORE UPDATE OR DELETE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skillplane_protect_published_version();

CREATE OR REPLACE FUNCTION skillplane_protect_published_file()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM skill_versions
    WHERE id = OLD.skill_version_id AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'files belonging to published skill versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER skill_version_files_protect_published
  BEFORE UPDATE OR DELETE ON skill_version_files
  FOR EACH ROW EXECUTE FUNCTION skillplane_protect_published_file();

CREATE OR REPLACE FUNCTION skillplane_validate_current_skill_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_published_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM skill_versions
    WHERE id = NEW.current_published_version_id
      AND skill_id = NEW.id
      AND workspace_id = NEW.workspace_id
      AND status = 'published'
  ) THEN
    RAISE EXCEPTION 'current skill version must be a published version of the same skill'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER skills_current_version_valid
  AFTER INSERT OR UPDATE OF current_published_version_id ON skills
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION skillplane_validate_current_skill_version();

CREATE OR REPLACE FUNCTION skillplane_validate_current_knowledge()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_knowledge_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_knowledge_revisions
    WHERE id = NEW.current_knowledge_revision_id
      AND context_id = NEW.id
      AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'current knowledge revision must belong to the same context'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER skill_contexts_current_knowledge_valid
  AFTER INSERT OR UPDATE OF current_knowledge_revision_id ON skill_contexts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION skillplane_validate_current_knowledge();

CREATE OR REPLACE FUNCTION skillplane_validate_current_note_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM context_note_revisions
    WHERE id = NEW.current_revision_id
      AND note_id = NEW.id
      AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'current note revision must belong to the same note'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER context_notes_current_revision_valid
  AFTER INSERT OR UPDATE OF current_revision_id ON context_notes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION skillplane_validate_current_note_revision();

COMMENT ON TABLE audit_events IS
  'Append-only audit ledger. Partitioning can be introduced by a forward migration when volume requires it.';
COMMENT ON TABLE analytics_daily IS
  'Rollup table. Raw audit events are authoritative; rollups may be rebuilt.';
COMMENT ON TABLE idempotency_records IS
  'Expired rows may be deleted by the retention job only after expires_at.';
COMMENT ON TABLE api_rate_limits IS
  'Ephemeral request counters. Expired rows are safe to delete after expires_at.';
