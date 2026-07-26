CREATE TABLE authfn_oauth_clients (
  client_id text PRIMARY KEY,
  client_name text NOT NULL,
  source text NOT NULL,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  registration_access_token_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authfn_oauth_clients_source CHECK (source IN ('dynamic', 'client_metadata')),
  CONSTRAINT authfn_oauth_clients_auth_method CHECK (token_endpoint_auth_method = 'none'),
  CONSTRAINT authfn_oauth_clients_name CHECK (char_length(client_name) BETWEEN 1 AND 200),
  CONSTRAINT authfn_oauth_clients_registration_hash CHECK (
    registration_access_token_hash IS NULL
    OR registration_access_token_hash ~ '^[a-f0-9]{64}$'
  )
);

CREATE TABLE authfn_oauth_client_redirect_uris (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES authfn_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  CONSTRAINT authfn_oauth_client_redirect_unique UNIQUE (client_id, redirect_uri),
  CONSTRAINT authfn_oauth_client_redirect_length CHECK (
    char_length(redirect_uri) BETWEEN 8 AND 2048
  )
);

CREATE TABLE authfn_oauth_consents (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES authfn_users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES authfn_oauth_clients(client_id) ON DELETE CASCADE,
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT authfn_oauth_consents_scopes CHECK (jsonb_typeof(scopes) = 'array'),
  CONSTRAINT authfn_oauth_consents_unique UNIQUE (user_id, client_id, resource)
);

CREATE TABLE authfn_oauth_authorization_requests (
  id text PRIMARY KEY,
  request_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  user_id text REFERENCES authfn_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authfn_oauth_authorization_requests_hash CHECK (
    request_hash ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT authfn_oauth_authorization_requests_payload CHECK (
    jsonb_typeof(payload) = 'object'
  ),
  CONSTRAINT authfn_oauth_authorization_requests_expiry CHECK (expires_at > created_at)
);

CREATE TABLE authfn_oauth_authorization_codes (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES authfn_users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES authfn_oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authfn_oauth_authorization_codes_hash CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT authfn_oauth_authorization_codes_scopes CHECK (jsonb_typeof(scopes) = 'array'),
  CONSTRAINT authfn_oauth_authorization_codes_challenge CHECK (
    code_challenge ~ '^[A-Za-z0-9_-]{43}$'
  ),
  CONSTRAINT authfn_oauth_authorization_codes_expiry CHECK (expires_at > created_at)
);

CREATE TABLE authfn_oauth_access_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  family_id text NOT NULL,
  user_id text NOT NULL REFERENCES authfn_users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES authfn_oauth_clients(client_id) ON DELETE CASCADE,
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authfn_oauth_access_tokens_hash CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT authfn_oauth_access_tokens_scopes CHECK (jsonb_typeof(scopes) = 'array'),
  CONSTRAINT authfn_oauth_access_tokens_expiry CHECK (expires_at > created_at)
);

CREATE TABLE authfn_oauth_refresh_tokens (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  family_id text NOT NULL,
  parent_id text REFERENCES authfn_oauth_refresh_tokens(id) ON DELETE RESTRICT,
  user_id text NOT NULL REFERENCES authfn_users(id) ON DELETE CASCADE,
  client_id text NOT NULL REFERENCES authfn_oauth_clients(client_id) ON DELETE CASCADE,
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authfn_oauth_refresh_tokens_hash CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT authfn_oauth_refresh_tokens_scopes CHECK (jsonb_typeof(scopes) = 'array'),
  CONSTRAINT authfn_oauth_refresh_tokens_expiry CHECK (expires_at > created_at)
);

CREATE INDEX authfn_oauth_authorization_requests_expiry_idx
  ON authfn_oauth_authorization_requests (expires_at);
CREATE INDEX authfn_oauth_authorization_codes_expiry_idx
  ON authfn_oauth_authorization_codes (expires_at);
CREATE INDEX authfn_oauth_consents_user_client_idx
  ON authfn_oauth_consents (user_id, client_id, revoked_at);
CREATE INDEX authfn_oauth_access_tokens_family_idx
  ON authfn_oauth_access_tokens (family_id, revoked_at);
CREATE INDEX authfn_oauth_access_tokens_user_idx
  ON authfn_oauth_access_tokens (user_id, expires_at);
CREATE INDEX authfn_oauth_refresh_tokens_family_idx
  ON authfn_oauth_refresh_tokens (family_id, revoked_at, consumed_at);

COMMENT ON TABLE authfn_oauth_authorization_codes IS
  'OAuth authorization codes are stored only as keyed HMAC-SHA-256 hashes.';
COMMENT ON TABLE authfn_oauth_access_tokens IS
  'OAuth access tokens are opaque, resource-bound, and stored only as keyed HMAC-SHA-256 hashes.';
COMMENT ON TABLE authfn_oauth_refresh_tokens IS
  'OAuth refresh tokens are rotating family members stored only as keyed HMAC-SHA-256 hashes.';
