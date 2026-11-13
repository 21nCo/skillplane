-- Reverses 0055_control_oauth_refresh_user_client_index.sql. Code keeps
-- working without the index: consent revocation falls back to a scan of
-- authfn_oauth_refresh_tokens. One transaction keeps the drop atomic with the
-- ledger update under any runner, and the local lock_timeout makes a busy table
-- refuse the rollback rather than queue an exclusive lock ahead of readers.
BEGIN;
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS authfn_oauth_refresh_tokens_user_client_live_idx;
DELETE FROM skillplane_schema_migrations
 WHERE id = '0055_control_oauth_refresh_user_client_index.sql';
COMMIT;
