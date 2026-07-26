CREATE TABLE authfn_otp_challenges (
  id text PRIMARY KEY,
  purpose text NOT NULL,
  email text NOT NULL,
  code_hash text NOT NULL,
  attempt_count integer NOT NULL,
  delivery_metadata jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT authfn_otp_challenges_purpose
    CHECK (purpose IN ('verify-email', 'sign-in', 'sign-up', 'reset-password')),
  CONSTRAINT authfn_otp_challenges_email_normalized
    CHECK (email = lower(email)),
  CONSTRAINT authfn_otp_challenges_code_hash
    CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT authfn_otp_challenges_attempt_count
    CHECK (attempt_count >= 0),
  CONSTRAINT authfn_otp_challenges_delivery_metadata_object
    CHECK (
      delivery_metadata IS NULL
      OR jsonb_typeof(delivery_metadata) = 'object'
    )
);

CREATE INDEX idx_authfn_otp_challenges_email_purpose_created_at
  ON authfn_otp_challenges (email, purpose, created_at);
CREATE INDEX idx_authfn_otp_challenges_expires_at
  ON authfn_otp_challenges (expires_at);

CREATE TABLE authfn_api_keys (
  id text PRIMARY KEY,
  user_id text REFERENCES authfn_users(id) ON DELETE CASCADE,
  name text,
  secret_hash text NOT NULL,
  scopes jsonb,
  metadata jsonb,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT authfn_api_keys_secret_hash
    CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT authfn_api_keys_scopes_array
    CHECK (scopes IS NULL OR jsonb_typeof(scopes) = 'array'),
  CONSTRAINT authfn_api_keys_metadata_object
    CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX idx_authfn_api_keys_secret_hash
  ON authfn_api_keys (secret_hash);
CREATE INDEX idx_authfn_api_keys_user_id_created_at
  ON authfn_api_keys (user_id, created_at);

COMMENT ON TABLE authfn_otp_challenges IS
  'AuthFn email OTP plugin challenges. Codes are stored only as hashes.';
COMMENT ON TABLE authfn_api_keys IS
  'AuthFn API-key plugin credentials. Secrets are returned once and stored only as hashes.';
