ALTER TABLE skill_versions
  DROP CONSTRAINT skill_versions_agent_attribution,
  ADD CONSTRAINT skill_versions_agent_attribution CHECK (
    source <> 'agent_amendment'
    OR (
      created_by_agent IS NOT NULL
      AND char_length(created_by_agent) BETWEEN 1 AND 200
      AND created_by_model IS NOT NULL
      AND char_length(created_by_model) BETWEEN 1 AND 200
      AND (
        created_for_user_id IS NULL
        OR char_length(created_for_user_id) BETWEEN 1 AND 200
      )
    )
  );

ALTER TABLE amendment_reviews
  DROP CONSTRAINT amendment_reviews_agent_attribution,
  ADD CONSTRAINT amendment_reviews_agent_attribution CHECK (
    requested_by_agent IS NULL
    OR (
      char_length(requested_by_agent) BETWEEN 1 AND 200
      AND requested_by_model IS NOT NULL
      AND char_length(requested_by_model) BETWEEN 1 AND 200
      AND (
        requested_for_user_id IS NULL
        OR char_length(requested_for_user_id) BETWEEN 1 AND 200
      )
    )
  );

ALTER TABLE context_knowledge_revisions
  DROP CONSTRAINT context_knowledge_agent_attribution,
  ADD CONSTRAINT context_knowledge_agent_attribution CHECK (
    (created_by_agent IS NULL AND created_by_model IS NULL)
    OR (
      created_by_agent IS NOT NULL
      AND char_length(created_by_agent) BETWEEN 1 AND 200
      AND created_by_model IS NOT NULL
      AND char_length(created_by_model) BETWEEN 1 AND 200
      AND (
        created_for_user_id IS NULL
        OR char_length(created_for_user_id) BETWEEN 1 AND 200
      )
    )
  );

ALTER TABLE context_note_revisions
  DROP CONSTRAINT context_note_revisions_agent_attribution,
  ADD CONSTRAINT context_note_revisions_agent_attribution CHECK (
    (created_by_agent IS NULL AND created_by_model IS NULL)
    OR (
      created_by_agent IS NOT NULL
      AND char_length(created_by_agent) BETWEEN 1 AND 200
      AND created_by_model IS NOT NULL
      AND char_length(created_by_model) BETWEEN 1 AND 200
      AND (
        created_for_user_id IS NULL
        OR char_length(created_for_user_id) BETWEEN 1 AND 200
      )
    )
  );

COMMENT ON CONSTRAINT skill_versions_agent_attribution ON skill_versions IS
  'Agent and model are caller-declared and paired; organization service principals may have no delegated user.';
COMMENT ON CONSTRAINT context_knowledge_agent_attribution ON context_knowledge_revisions IS
  'Agent and model are caller-declared and paired; organization service principals may have no delegated user.';
COMMENT ON CONSTRAINT context_note_revisions_agent_attribution ON context_note_revisions IS
  'Agent and model are caller-declared and paired; organization service principals may have no delegated user.';
