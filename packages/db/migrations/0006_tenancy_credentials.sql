ALTER TABLE workspaces
  ADD COLUMN kind text NOT NULL DEFAULT 'organization',
  ADD COLUMN created_by_user_id text REFERENCES authfn_users(id) ON DELETE SET NULL,
  ADD COLUMN personal_owner_user_id text REFERENCES authfn_users(id) ON DELETE RESTRICT;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_kind CHECK (kind IN ('personal', 'organization')),
  ADD CONSTRAINT workspaces_personal_owner CHECK (
    (kind = 'personal' AND personal_owner_user_id IS NOT NULL)
    OR (kind = 'organization' AND personal_owner_user_id IS NULL)
  );

CREATE UNIQUE INDEX workspaces_personal_owner_unique
  ON workspaces (personal_owner_user_id)
  WHERE personal_owner_user_id IS NOT NULL;

DROP INDEX workspace_invitations_workspace_email_idx;
ALTER TABLE workspace_invitations
  DROP CONSTRAINT workspace_invitations_email_normalized;
ALTER TABLE workspace_invitations
  RENAME COLUMN email TO email_ciphertext;
ALTER TABLE workspace_invitations
  ADD COLUMN email_hash text,
  ADD COLUMN accepted_by_user_id text REFERENCES authfn_users(id) ON DELETE SET NULL;
UPDATE workspace_invitations
   SET email_hash = encode(sha256(convert_to(lower(email_ciphertext), 'UTF8')), 'hex'),
       email_ciphertext =
         'legacy.' || encode(convert_to(email_ciphertext, 'UTF8'), 'base64');
ALTER TABLE workspace_invitations
  ALTER COLUMN email_hash SET NOT NULL,
  ADD CONSTRAINT workspace_invitations_email_hash
    CHECK (email_hash ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT workspace_invitations_email_ciphertext
    CHECK (char_length(email_ciphertext) BETWEEN 16 AND 4096);
CREATE INDEX workspace_invitations_workspace_email_hash_idx
  ON workspace_invitations (workspace_id, email_hash);

ALTER TABLE service_principals
  ADD COLUMN role text NOT NULL DEFAULT 'viewer',
  ADD COLUMN created_by_user_id text REFERENCES authfn_users(id) ON DELETE SET NULL,
  ADD COLUMN delegated_user_id text REFERENCES authfn_users(id) ON DELETE SET NULL,
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN credential_version integer NOT NULL DEFAULT 1;
ALTER TABLE service_principals
  DROP CONSTRAINT service_principals_scopes_allowed,
  ADD CONSTRAINT service_principals_role
    CHECK (role IN ('viewer', 'editor', 'admin')),
  ADD CONSTRAINT service_principals_expiry
    CHECK (expires_at IS NULL OR expires_at > created_at),
  ADD CONSTRAINT service_principals_credential_version
    CHECK (credential_version > 0),
  ADD CONSTRAINT service_principals_scopes_allowed CHECK (
    scopes <@ ARRAY[
      'skills:read', 'skills:write', 'skills:amend',
      'contexts:read', 'contexts:write',
      'members:read', 'members:write',
      'analytics:read', 'audit:read'
    ]::text[]
  );

CREATE INDEX service_principals_workspace_status_idx
  ON service_principals (workspace_id, revoked_at, expires_at, id);
