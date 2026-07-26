CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE authfn_users (
  id text PRIMARY KEY,
  primary_email text,
  email_verified_at timestamptz,
  metadata jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT authfn_users_primary_email_normalized
    CHECK (primary_email IS NULL OR primary_email = lower(primary_email))
);

CREATE UNIQUE INDEX idx_authfn_users_primary_email
  ON authfn_users (primary_email)
  WHERE primary_email IS NOT NULL;

CREATE TABLE authfn_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES authfn_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  csrf_hash text,
  methods jsonb NOT NULL,
  metadata jsonb,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_authenticated_at timestamptz,
  CONSTRAINT authfn_sessions_methods_array CHECK (jsonb_typeof(methods) = 'array')
);

CREATE INDEX idx_authfn_sessions_expires_at
  ON authfn_sessions (expires_at);
CREATE UNIQUE INDEX idx_authfn_sessions_token_hash
  ON authfn_sessions (token_hash);
CREATE INDEX idx_authfn_sessions_user_id_created_at
  ON authfn_sessions (user_id, created_at);

COMMENT ON TABLE authfn_users IS
  'AuthFn schema v1 core users. Owned by @authfn/core; do not duplicate in application migrations.';
COMMENT ON TABLE authfn_sessions IS
  'AuthFn schema v1 core sessions. Owned by @authfn/core; do not duplicate in application migrations.';
