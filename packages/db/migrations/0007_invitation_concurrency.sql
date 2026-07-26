UPDATE workspace_invitations
   SET revoked_at = now()
 WHERE accepted_at IS NULL
   AND revoked_at IS NULL
   AND expires_at <= now();

CREATE UNIQUE INDEX workspace_invitations_active_email_unique
  ON workspace_invitations (workspace_id, email_hash)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
