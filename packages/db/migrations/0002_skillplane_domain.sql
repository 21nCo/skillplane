CREATE TABLE workspaces (
  id text PRIMARY KEY,
  workspace_id text NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_tenant_identity CHECK (workspace_id = id),
  CONSTRAINT workspaces_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT workspaces_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT workspaces_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE workspace_memberships (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES authfn_users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_memberships_role
    CHECK (role IN ('viewer', 'editor', 'admin', 'owner')),
  CONSTRAINT workspace_memberships_workspace_user_unique
    UNIQUE (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user_idx
  ON workspace_memberships (user_id, workspace_id);

CREATE TABLE workspace_invitations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by_user_id text NOT NULL REFERENCES authfn_users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_invitations_email_normalized CHECK (email = lower(email)),
  CONSTRAINT workspace_invitations_role
    CHECK (role IN ('viewer', 'editor', 'admin')),
  CONSTRAINT workspace_invitations_terminal_state
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX workspace_invitations_workspace_email_idx
  ON workspace_invitations (workspace_id, email);

CREATE TABLE service_principals (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  credential_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_principals_workspace_name_unique UNIQUE (workspace_id, name),
  CONSTRAINT service_principals_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT service_principals_scopes_allowed CHECK (
    scopes <@ ARRAY[
      'skills:read', 'skills:write', 'contexts:read', 'contexts:write',
      'members:read', 'members:write', 'analytics:read', 'audit:read'
    ]::text[]
  )
);

CREATE TABLE skills (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  visibility text NOT NULL DEFAULT 'private',
  current_published_version_id text,
  created_by_user_id text REFERENCES authfn_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT skills_workspace_slug_unique UNIQUE (workspace_id, slug),
  CONSTRAINT skills_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT skills_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT skills_name_length CHECK (char_length(name) BETWEEN 1 AND 160),
  CONSTRAINT skills_description_size CHECK (octet_length(description) <= 20000),
  CONSTRAINT skills_visibility CHECK (visibility IN ('private', 'workspace', 'public'))
);
CREATE INDEX skills_workspace_updated_idx
  ON skills (workspace_id, updated_at DESC);

CREATE TABLE skill_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id text NOT NULL,
  revision integer NOT NULL,
  semantic_version text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  source text NOT NULL,
  content_digest text NOT NULL,
  manifest jsonb NOT NULL,
  learning_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_summary text NOT NULL DEFAULT '',
  created_by_actor_type text NOT NULL,
  created_by_actor_id text NOT NULL,
  created_by_agent text,
  created_by_model text,
  created_for_user_id text,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_versions_skill_tenant_fk
    FOREIGN KEY (workspace_id, skill_id)
    REFERENCES skills(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT skill_versions_skill_revision_unique UNIQUE (skill_id, revision),
  CONSTRAINT skill_versions_skill_semver_unique UNIQUE (skill_id, semantic_version),
  CONSTRAINT skill_versions_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT skill_versions_revision_positive CHECK (revision > 0),
  CONSTRAINT skill_versions_semver_format CHECK (
    semantic_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
  ),
  CONSTRAINT skill_versions_status CHECK (status IN ('draft', 'pending_review', 'published', 'rejected')),
  CONSTRAINT skill_versions_source CHECK (source IN ('human', 'agent_amendment', 'import')),
  CONSTRAINT skill_versions_digest_format CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  CONSTRAINT skill_versions_manifest_object CHECK (jsonb_typeof(manifest) = 'object'),
  CONSTRAINT skill_versions_learning_metadata_object
    CHECK (jsonb_typeof(learning_metadata) = 'object'),
  CONSTRAINT skill_versions_actor_type
    CHECK (created_by_actor_type IN ('user', 'service_principal', 'system')),
  CONSTRAINT skill_versions_publication_state CHECK (
    (status = 'published' AND published_at IS NOT NULL)
    OR (status <> 'published' AND published_at IS NULL)
  ),
  CONSTRAINT skill_versions_agent_attribution CHECK (
    source <> 'agent_amendment'
    OR (
      created_by_agent IS NOT NULL AND char_length(created_by_agent) > 0
      AND created_by_model IS NOT NULL AND char_length(created_by_model) > 0
      AND created_for_user_id IS NOT NULL AND char_length(created_for_user_id) > 0
    )
  )
);
CREATE INDEX skill_versions_workspace_skill_revision_idx
  ON skill_versions (workspace_id, skill_id, revision DESC);

CREATE TABLE skill_version_files (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_version_id text NOT NULL,
  path text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL,
  sha256 text NOT NULL,
  r2_object_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_version_files_version_tenant_fk
    FOREIGN KEY (workspace_id, skill_version_id)
    REFERENCES skill_versions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT skill_version_files_version_path_unique UNIQUE (skill_version_id, path),
  CONSTRAINT skill_version_files_path_safe CHECK (
    char_length(path) BETWEEN 1 AND 512
    AND path !~ '(^/|(^|/)\.\.(/|$)|//)'
  ),
  CONSTRAINT skill_version_files_size CHECK (byte_size BETWEEN 0 AND 10485760),
  CONSTRAINT skill_version_files_sha256 CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT skill_version_files_r2_key CHECK (char_length(r2_object_key) BETWEEN 1 AND 1024)
);
CREATE INDEX skill_version_files_workspace_version_idx
  ON skill_version_files (workspace_id, skill_version_id);

CREATE TABLE skill_contexts (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_knowledge_revision_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT skill_contexts_skill_tenant_fk
    FOREIGN KEY (workspace_id, skill_id)
    REFERENCES skills(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT skill_contexts_skill_slug_unique UNIQUE (skill_id, slug),
  CONSTRAINT skill_contexts_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT skill_contexts_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT skill_contexts_name_length CHECK (char_length(name) BETWEEN 1 AND 160),
  CONSTRAINT skill_contexts_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX skill_contexts_workspace_skill_idx
  ON skill_contexts (workspace_id, skill_id, updated_at DESC);

CREATE TABLE context_knowledge_revisions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_id text NOT NULL,
  revision integer NOT NULL,
  knowledge text NOT NULL,
  learning_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text NOT NULL,
  created_by_agent text,
  created_by_model text,
  created_for_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_knowledge_context_tenant_fk
    FOREIGN KEY (workspace_id, context_id)
    REFERENCES skill_contexts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT context_knowledge_context_revision_unique UNIQUE (context_id, revision),
  CONSTRAINT context_knowledge_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT context_knowledge_revision_positive CHECK (revision > 0),
  CONSTRAINT context_knowledge_size CHECK (octet_length(knowledge) BETWEEN 1 AND 1048576),
  CONSTRAINT context_knowledge_metadata_object
    CHECK (jsonb_typeof(learning_metadata) = 'object'),
  CONSTRAINT context_knowledge_actor_type
    CHECK (created_by_actor_type IN ('user', 'service_principal', 'system')),
  CONSTRAINT context_knowledge_agent_attribution CHECK (
    created_by_agent IS NULL
    OR (
      created_by_model IS NOT NULL AND char_length(created_by_model) > 0
      AND created_for_user_id IS NOT NULL AND char_length(created_for_user_id) > 0
    )
  )
);
CREATE INDEX context_knowledge_workspace_context_revision_idx
  ON context_knowledge_revisions (workspace_id, context_id, revision DESC);

CREATE TABLE context_notes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_id text NOT NULL,
  agent_key text NOT NULL,
  title text NOT NULL,
  current_revision_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT context_notes_context_tenant_fk
    FOREIGN KEY (workspace_id, context_id)
    REFERENCES skill_contexts(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT context_notes_context_agent_unique UNIQUE (context_id, agent_key),
  CONSTRAINT context_notes_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT context_notes_agent_key_length CHECK (char_length(agent_key) BETWEEN 1 AND 240),
  CONSTRAINT context_notes_title_length CHECK (char_length(title) BETWEEN 1 AND 240)
);
CREATE INDEX context_notes_workspace_context_idx
  ON context_notes (workspace_id, context_id, updated_at DESC);

CREATE TABLE context_note_revisions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  note_id text NOT NULL,
  revision integer NOT NULL,
  body text NOT NULL,
  learning_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_actor_type text NOT NULL,
  created_by_actor_id text NOT NULL,
  created_by_agent text,
  created_by_model text,
  created_for_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_note_revisions_note_tenant_fk
    FOREIGN KEY (workspace_id, note_id)
    REFERENCES context_notes(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT context_note_revisions_note_revision_unique UNIQUE (note_id, revision),
  CONSTRAINT context_note_revisions_workspace_id_id_unique UNIQUE (workspace_id, id),
  CONSTRAINT context_note_revisions_revision_positive CHECK (revision > 0),
  CONSTRAINT context_note_revisions_body_size CHECK (octet_length(body) BETWEEN 1 AND 1048576),
  CONSTRAINT context_note_revisions_metadata_object
    CHECK (jsonb_typeof(learning_metadata) = 'object'),
  CONSTRAINT context_note_revisions_actor_type
    CHECK (created_by_actor_type IN ('user', 'service_principal', 'system')),
  CONSTRAINT context_note_revisions_agent_attribution CHECK (
    created_by_agent IS NULL
    OR (
      created_by_model IS NOT NULL AND char_length(created_by_model) > 0
      AND created_for_user_id IS NOT NULL AND char_length(created_for_user_id) > 0
    )
  )
);
CREATE INDEX context_note_revisions_workspace_note_idx
  ON context_note_revisions (workspace_id, note_id, revision DESC);

CREATE TABLE amendment_reviews (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  skill_id text NOT NULL,
  proposed_version_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decision_reason text,
  requested_by_actor_type text NOT NULL,
  requested_by_actor_id text NOT NULL,
  requested_by_agent text,
  requested_by_model text,
  requested_for_user_id text,
  reviewed_by_user_id text REFERENCES authfn_users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT amendment_reviews_skill_tenant_fk
    FOREIGN KEY (workspace_id, skill_id)
    REFERENCES skills(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT amendment_reviews_version_tenant_fk
    FOREIGN KEY (workspace_id, proposed_version_id)
    REFERENCES skill_versions(workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT amendment_reviews_proposed_version_unique UNIQUE (proposed_version_id),
  CONSTRAINT amendment_reviews_status
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  CONSTRAINT amendment_reviews_actor_type
    CHECK (requested_by_actor_type IN ('user', 'service_principal', 'system')),
  CONSTRAINT amendment_reviews_agent_attribution CHECK (
    requested_by_agent IS NOT NULL AND char_length(requested_by_agent) > 0
    AND requested_by_model IS NOT NULL AND char_length(requested_by_model) > 0
    AND requested_for_user_id IS NOT NULL AND char_length(requested_for_user_id) > 0
  ),
  CONSTRAINT amendment_reviews_decision_state CHECK (
    (status = 'pending' AND reviewed_at IS NULL AND reviewed_by_user_id IS NULL)
    OR (status <> 'pending' AND reviewed_at IS NOT NULL)
  )
);
CREATE INDEX amendment_reviews_workspace_status_idx
  ON amendment_reviews (workspace_id, status, created_at DESC);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  action text NOT NULL,
  outcome text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  user_id text,
  agent text,
  model text,
  request_id text NOT NULL,
  resource_type text,
  resource_id text,
  context_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_events_outcome CHECK (outcome IN ('success', 'denied', 'error')),
  CONSTRAINT audit_events_actor_type
    CHECK (actor_type IN ('user', 'service_principal', 'system')),
  CONSTRAINT audit_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_events_agent_identity CHECK (
    agent IS NULL OR (model IS NOT NULL AND user_id IS NOT NULL)
  )
);
CREATE INDEX audit_events_workspace_time_idx
  ON audit_events (workspace_id, occurred_at DESC);
CREATE INDEX audit_events_workspace_resource_idx
  ON audit_events (workspace_id, resource_type, resource_id);
CREATE INDEX audit_events_request_idx ON audit_events (request_id);

CREATE TABLE analytics_daily (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day date NOT NULL,
  skill_id text NOT NULL DEFAULT '',
  context_id text NOT NULL DEFAULT '',
  agent text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  retrieval_count bigint NOT NULL DEFAULT 0,
  amendment_count bigint NOT NULL DEFAULT 0,
  context_write_count bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_daily_pk PRIMARY KEY (
    workspace_id, day, skill_id, context_id, agent, model
  ),
  CONSTRAINT analytics_daily_counts_nonnegative CHECK (
    retrieval_count >= 0 AND amendment_count >= 0 AND context_write_count >= 0
  )
);
CREATE INDEX analytics_daily_workspace_day_idx
  ON analytics_daily (workspace_id, day DESC);

CREATE TABLE idempotency_records (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  locked_until timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_records_pk PRIMARY KEY (workspace_id, key, operation),
  CONSTRAINT idempotency_records_key_length CHECK (char_length(key) BETWEEN 1 AND 255),
  CONSTRAINT idempotency_records_hash_format CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT idempotency_records_response_status CHECK (
    response_status IS NULL OR response_status BETWEEN 100 AND 599
  )
);
CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE api_rate_limits (
  bucket_hash text NOT NULL,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  CONSTRAINT api_rate_limits_pk PRIMARY KEY (bucket_hash, window_started_at),
  CONSTRAINT api_rate_limits_count_nonnegative CHECK (request_count >= 0)
);
CREATE INDEX api_rate_limits_expiry_idx ON api_rate_limits (expires_at);
