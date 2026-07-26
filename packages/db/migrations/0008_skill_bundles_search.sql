ALTER TABLE skills
  ADD COLUMN next_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN amendment_policy jsonb NOT NULL
    DEFAULT '{"mode":"review_required"}'::jsonb,
  ADD COLUMN published_search_text text NOT NULL DEFAULT '',
  ADD COLUMN context_search_text text NOT NULL DEFAULT '';

UPDATE skills AS skill
SET next_revision = COALESCE(
  (
    SELECT max(version.revision) + 1
    FROM skill_versions AS version
    WHERE version.skill_id = skill.id
  ),
  1
);

ALTER TABLE skills
  ADD CONSTRAINT skills_next_revision_positive CHECK (next_revision > 0),
  ADD CONSTRAINT skills_amendment_policy_object
    CHECK (jsonb_typeof(amendment_policy) = 'object');

ALTER TABLE skill_versions
  DROP CONSTRAINT skill_versions_publication_state,
  ALTER COLUMN semantic_version DROP NOT NULL,
  ADD COLUMN base_version_id text,
  ADD COLUMN proposed_bump text,
  ADD COLUMN r2_object_key text,
  ADD COLUMN bundle_byte_size bigint;

UPDATE skill_versions
SET semantic_version = NULL
WHERE status <> 'published';

UPDATE skill_versions
SET
  r2_object_key = format(
    'workspaces/%s/skills/%s/bundles/sha256/%s.zip',
    workspace_id,
    skill_id,
    replace(content_digest, 'sha256:', '')
  ),
  bundle_byte_size = CASE
    WHEN manifest->>'byteSize' ~ '^[0-9]+$'
      THEN GREATEST((manifest->>'byteSize')::bigint, 1)
    ELSE 1
  END;

ALTER TABLE skill_versions
  ALTER COLUMN r2_object_key SET NOT NULL,
  ALTER COLUMN bundle_byte_size SET NOT NULL,
  ADD CONSTRAINT skill_versions_workspace_skill_id_unique
    UNIQUE (workspace_id, skill_id, id),
  ADD CONSTRAINT skill_versions_base_tenant_fk
    FOREIGN KEY (workspace_id, skill_id, base_version_id)
    REFERENCES skill_versions(workspace_id, skill_id, id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT skill_versions_revision_base CHECK (
    (revision = 1 AND base_version_id IS NULL)
    OR (revision > 1 AND base_version_id IS NOT NULL)
  ),
  ADD CONSTRAINT skill_versions_proposed_bump CHECK (
    proposed_bump IS NULL OR proposed_bump IN ('patch', 'minor', 'major')
  ),
  ADD CONSTRAINT skill_versions_r2_key CHECK (
    r2_object_key ~
      '^workspaces/[A-Za-z0-9:_-]+/skills/[A-Za-z0-9:_-]+/bundles/sha256/[a-f0-9]{64}\.zip$'
  ),
  ADD CONSTRAINT skill_versions_bundle_size CHECK (
    bundle_byte_size BETWEEN 1 AND 10485760
  ),
  ADD CONSTRAINT skill_versions_publication_state CHECK (
    (
      status = 'published'
      AND published_at IS NOT NULL
      AND semantic_version IS NOT NULL
    )
    OR (
      status <> 'published'
      AND published_at IS NULL
      AND semantic_version IS NULL
    )
  );

ALTER TABLE skill_version_files
  DROP CONSTRAINT skill_version_files_path_safe,
  DROP CONSTRAINT skill_version_files_size,
  ADD CONSTRAINT skill_version_files_path_safe CHECK (
    char_length(path) BETWEEN 1 AND 240
    AND octet_length(path) BETWEEN 1 AND 240
    AND path !~ '(^/|(^|/)\.\.(/|$)|//|\\)'
  ),
  ADD CONSTRAINT skill_version_files_size
    CHECK (byte_size BETWEEN 0 AND 5242880);

ALTER TABLE idempotency_records
  DROP CONSTRAINT idempotency_records_pk,
  ADD COLUMN principal_key text NOT NULL DEFAULT 'legacy',
  ADD CONSTRAINT idempotency_records_principal_key_length
    CHECK (char_length(principal_key) BETWEEN 1 AND 240),
  ADD CONSTRAINT idempotency_records_pk PRIMARY KEY (
    workspace_id,
    principal_key,
    key,
    operation
  );

DROP INDEX skills_search_idx;

CREATE OR REPLACE FUNCTION skillplane_skill_search_document_v2(
  skill_name text,
  skill_description text,
  skill_tags text[],
  published_content text,
  context_content text
)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURN setweight(to_tsvector('simple', coalesce(skill_name, '')), 'A')
  || setweight(to_tsvector('simple', coalesce(skill_description, '')), 'B')
  || setweight(
    to_tsvector('simple', coalesce(array_to_string(skill_tags, ' '), '')),
    'B'
  )
  || setweight(to_tsvector('simple', coalesce(published_content, '')), 'C')
  || setweight(to_tsvector('simple', coalesce(context_content, '')), 'D');

ALTER TABLE skills
  ADD COLUMN public_search_document tsvector
    GENERATED ALWAYS AS (
      skillplane_skill_search_document_v2(
        name,
        description,
        tags,
        published_search_text,
        ''
      )
    ) STORED,
  ADD COLUMN workspace_search_document tsvector
    GENERATED ALWAYS AS (
      skillplane_skill_search_document_v2(
        name,
        description,
        tags,
        published_search_text,
        context_search_text
      )
    ) STORED;

CREATE INDEX skills_public_search_idx
  ON skills USING gin (public_search_document)
  WHERE
    visibility = 'public'
    AND archived_at IS NULL
    AND current_published_version_id IS NOT NULL;

CREATE INDEX skills_workspace_search_idx
  ON skills USING gin (workspace_search_document)
  WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION skillplane_refresh_context_search()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_skill_id text;
  new_skill_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_skill_id := OLD.skill_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_skill_id := NEW.skill_id;
  END IF;

  IF old_skill_id IS NOT NULL THEN
    UPDATE skills
    SET context_search_text = COALESCE(
      (
        SELECT string_agg(
          context.name || ' ' || context.description,
          ' '
          ORDER BY context.id
        )
        FROM skill_contexts AS context
        WHERE context.skill_id = old_skill_id
          AND context.archived_at IS NULL
      ),
      ''
    )
    WHERE id = old_skill_id;
  END IF;

  IF new_skill_id IS NOT NULL AND new_skill_id IS DISTINCT FROM old_skill_id THEN
    UPDATE skills
    SET context_search_text = COALESCE(
      (
        SELECT string_agg(
          context.name || ' ' || context.description,
          ' '
          ORDER BY context.id
        )
        FROM skill_contexts AS context
        WHERE context.skill_id = new_skill_id
          AND context.archived_at IS NULL
      ),
      ''
    )
    WHERE id = new_skill_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER skill_contexts_refresh_search
  AFTER INSERT OR UPDATE OF name, description, archived_at, skill_id OR DELETE
  ON skill_contexts
  FOR EACH ROW EXECUTE FUNCTION skillplane_refresh_context_search();

COMMENT ON COLUMN skills.public_search_document IS
  'Public-only search vector. Context metadata is deliberately excluded.';
COMMENT ON COLUMN skills.workspace_search_document IS
  'Authorized workspace search vector including non-archived context names.';
COMMENT ON COLUMN skill_versions.r2_object_key IS
  'Private content-addressed canonical ZIP key; never expose as a public bucket URL.';
