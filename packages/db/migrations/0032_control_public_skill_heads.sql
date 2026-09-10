-- skillplane:roles=combined,control
-- Keep the current public version as skill-wide control-plane state. Historical
-- projection documents are immutable snapshots and cannot decide which version
-- is current after a later publication.

CREATE TABLE public_skill_projection_heads (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id text NOT NULL,
  current_version_id text NOT NULL,
  state text NOT NULL DEFAULT 'published'
    CHECK (state IN ('published', 'unpublished')),
  projection_sequence bigint NOT NULL DEFAULT 0
    CHECK (projection_sequence >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_skill_projection_heads_pk
    PRIMARY KEY (workspace_id, skill_id)
);

INSERT INTO public_skill_projection_heads
  (workspace_id, skill_id, current_version_id, state, projection_sequence)
SELECT DISTINCT ON (workspace_id, skill_id)
       workspace_id,
       skill_id,
       COALESCE(
         document->'skill'->>'currentPublishedVersionId',
         version_id
       ),
       state,
       projection_sequence
  FROM public_skill_projections
 ORDER BY workspace_id, skill_id, projection_sequence DESC,
          updated_at DESC, version_id ASC;

COMMENT ON TABLE public_skill_projection_heads IS
  'Authoritative sequence-fenced current-version decision for each globally projected public skill.';
