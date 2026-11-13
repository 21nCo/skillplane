-- skillplane:roles=combined,control
-- Revoking an MCP OAuth consent revokes every live refresh token the user holds
-- for that client while it holds the consent row lock, which blocks the
-- client's refresh and code exchange. Refresh tokens accumulate on every
-- rotation and are not pruned, so index the sweep by user and client. The
-- partial predicate keeps only live rows, which is what the sweep updates. The
-- change is additive; reverse it with
-- rollback/0055_control_oauth_refresh_user_client_index.sql.
CREATE INDEX authfn_oauth_refresh_tokens_user_client_live_idx
  ON authfn_oauth_refresh_tokens (user_id, client_id)
  WHERE revoked_at IS NULL;
