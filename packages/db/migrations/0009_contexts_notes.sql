CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE skill_contexts
  ADD COLUMN context_type text NOT NULL DEFAULT 'custom',
  ADD COLUMN external_reference text;

ALTER TABLE skill_contexts
  ADD CONSTRAINT skill_contexts_type_valid
    CHECK (context_type IN ('repository', 'project', 'customer', 'environment', 'custom')),
  ADD CONSTRAINT skill_contexts_description_length
    CHECK (char_length(description) <= 2000),
  ADD CONSTRAINT skill_contexts_external_reference_length
    CHECK (external_reference IS NULL OR char_length(external_reference) BETWEEN 1 AND 2000);

ALTER TABLE context_knowledge_revisions
  DISABLE TRIGGER context_knowledge_revisions_immutable;

ALTER TABLE context_knowledge_revisions
  ADD COLUMN base_revision_id text,
  ADD COLUMN body_digest text NOT NULL DEFAULT ('sha256:' || repeat('0', 64));

UPDATE context_knowledge_revisions revision
   SET base_revision_id = base.id
  FROM context_knowledge_revisions base
 WHERE revision.context_id = base.context_id
   AND revision.revision = base.revision + 1;

UPDATE context_knowledge_revisions
   SET body_digest =
       'sha256:' || encode(digest(convert_to(knowledge, 'UTF8'), 'sha256'), 'hex');

ALTER TABLE context_knowledge_revisions
  ALTER COLUMN body_digest DROP DEFAULT,
  DROP CONSTRAINT context_knowledge_size,
  ADD CONSTRAINT context_knowledge_size
    CHECK (octet_length(knowledge) BETWEEN 1 AND 524288),
  ADD CONSTRAINT context_knowledge_digest_valid
    CHECK (body_digest ~ '^sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT context_knowledge_context_id_id_unique
    UNIQUE (context_id, id),
  ADD CONSTRAINT context_knowledge_base_same_context_fk
    FOREIGN KEY (context_id, base_revision_id)
    REFERENCES context_knowledge_revisions(context_id, id);

ALTER TABLE context_knowledge_revisions
  ENABLE TRIGGER context_knowledge_revisions_immutable;

ALTER TABLE context_notes
  RENAME COLUMN agent_key TO note_key;

ALTER TABLE context_notes
  RENAME CONSTRAINT context_notes_context_agent_unique
  TO context_notes_context_note_key_unique;

ALTER TABLE context_notes
  RENAME CONSTRAINT context_notes_agent_key_length
  TO context_notes_note_key_length;

ALTER TABLE context_note_revisions
  DISABLE TRIGGER context_note_revisions_immutable;

ALTER TABLE context_note_revisions
  ADD COLUMN base_revision_id text,
  ADD COLUMN title text NOT NULL DEFAULT '',
  ADD COLUMN body_digest text NOT NULL DEFAULT ('sha256:' || repeat('0', 64));

UPDATE context_note_revisions revision
   SET base_revision_id = base.id
  FROM context_note_revisions base
 WHERE revision.note_id = base.note_id
   AND revision.revision = base.revision + 1;

UPDATE context_note_revisions revision
   SET title = note.title,
       body_digest =
         'sha256:' || encode(digest(convert_to(revision.body, 'UTF8'), 'sha256'), 'hex')
  FROM context_notes note
 WHERE note.id = revision.note_id;

ALTER TABLE context_note_revisions
  ALTER COLUMN title DROP DEFAULT,
  ALTER COLUMN body_digest DROP DEFAULT,
  DROP CONSTRAINT context_note_revisions_body_size,
  ADD CONSTRAINT context_note_revisions_body_size
    CHECK (octet_length(body) BETWEEN 1 AND 262144),
  ADD CONSTRAINT context_note_revisions_title_length
    CHECK (char_length(title) BETWEEN 1 AND 240),
  ADD CONSTRAINT context_note_revisions_digest_valid
    CHECK (body_digest ~ '^sha256:[a-f0-9]{64}$'),
  ADD CONSTRAINT context_note_revisions_note_id_id_unique
    UNIQUE (note_id, id),
  ADD CONSTRAINT context_note_revisions_base_same_note_fk
    FOREIGN KEY (note_id, base_revision_id)
    REFERENCES context_note_revisions(note_id, id);

ALTER TABLE context_note_revisions
  ENABLE TRIGGER context_note_revisions_immutable;
