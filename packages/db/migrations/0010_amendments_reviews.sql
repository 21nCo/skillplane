ALTER TABLE skill_versions
  ADD COLUMN amendment_operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN caller_declaration jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN policy_decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT skill_versions_amendment_operations_array
    CHECK (jsonb_typeof(amendment_operations) = 'array'),
  ADD CONSTRAINT skill_versions_caller_declaration_object
    CHECK (jsonb_typeof(caller_declaration) = 'object'),
  ADD CONSTRAINT skill_versions_policy_decision_object
    CHECK (jsonb_typeof(policy_decision) = 'object');

ALTER TABLE amendment_reviews
  DROP CONSTRAINT amendment_reviews_agent_attribution,
  DROP CONSTRAINT amendment_reviews_decision_state,
  ADD COLUMN policy_decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN reviewed_by_actor_type text,
  ADD COLUMN reviewed_by_actor_id text,
  ADD CONSTRAINT amendment_reviews_agent_attribution CHECK (
    requested_by_agent IS NULL
    OR (
      char_length(requested_by_agent) BETWEEN 1 AND 200
      AND requested_by_model IS NOT NULL
      AND char_length(requested_by_model) BETWEEN 1 AND 200
      AND requested_for_user_id IS NOT NULL
      AND char_length(requested_for_user_id) BETWEEN 1 AND 200
    )
  ),
  ADD CONSTRAINT amendment_reviews_policy_decision_object
    CHECK (jsonb_typeof(policy_decision) = 'object'),
  ADD CONSTRAINT amendment_reviews_reviewer_actor_type CHECK (
    reviewed_by_actor_type IS NULL
    OR reviewed_by_actor_type IN ('user', 'service_principal', 'system')
  ),
  ADD CONSTRAINT amendment_reviews_decision_state CHECK (
    (
      status = 'pending'
      AND reviewed_at IS NULL
      AND reviewed_by_user_id IS NULL
      AND reviewed_by_actor_type IS NULL
      AND reviewed_by_actor_id IS NULL
    )
    OR (
      status <> 'pending'
      AND reviewed_at IS NOT NULL
      AND reviewed_by_actor_type IS NOT NULL
      AND reviewed_by_actor_id IS NOT NULL
    )
  );

CREATE INDEX amendment_reviews_workspace_skill_created_idx
  ON amendment_reviews (workspace_id, skill_id, created_at DESC, id DESC);

COMMENT ON COLUMN skill_versions.caller_declaration IS
  'Declared agent, model, client, and run correlation. Authenticated actor identity remains in created_by_actor_* and is never accepted from request input.';
COMMENT ON COLUMN skill_versions.policy_decision IS
  'Immutable policy evaluation captured when an amendment candidate is created.';
COMMENT ON COLUMN skill_versions.amendment_operations IS
  'Validated deterministic add, replace, and delete operations used to produce an agent amendment.';
