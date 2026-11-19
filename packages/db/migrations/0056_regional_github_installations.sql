-- skillplane:roles=combined,regional
-- GitHub App installations bound to a workspace. An installation is bound to
-- at most one workspace in a database (installation_id is the primary key),
-- so a second bind of the same installation is refused and two concurrent
-- binds serialize on the key. suspended_at and removed_at mirror the
-- installation's state on GitHub as last observed. The change is additive.
CREATE TABLE github_installations (
  installation_id bigint PRIMARY KEY,
  workspace_id text NOT NULL,
  account_login text NOT NULL,
  account_type text NOT NULL,
  repository_selection text NOT NULL,
  suspended_at timestamptz,
  removed_at timestamptz,
  bound_by text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_installations_installation_id_check CHECK (installation_id > 0),
  CONSTRAINT github_installations_account_login_check
    CHECK (char_length(account_login) BETWEEN 1 AND 100),
  CONSTRAINT github_installations_account_type_check
    CHECK (account_type IN ('User', 'Organization', 'Enterprise')),
  CONSTRAINT github_installations_repository_selection_check
    CHECK (repository_selection IN ('all', 'selected')),
  UNIQUE (workspace_id, installation_id)
);
-- Install callbacks consume their signed state's nonce here, so a state is
-- accepted at most once. Rows are kept until the state has expired.
CREATE TABLE github_installation_states (
  nonce text PRIMARY KEY,
  workspace_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_installation_states_nonce_check
    CHECK (nonce ~ '^[A-Za-z0-9_-]{22,64}$')
);
CREATE INDEX github_installation_states_expiry_idx
  ON github_installation_states (workspace_id, expires_at);
-- A source reading a private repository names the installation it reads
-- through. Unbinding keeps the source and this reference, so binding the
-- installation again restores access.
ALTER TABLE skill_sources ADD COLUMN github_installation_id bigint;
ALTER TABLE skill_sources ADD CONSTRAINT skill_sources_github_installation_id_check
  CHECK (github_installation_id > 0);
CREATE INDEX skill_sources_github_installation_idx
  ON skill_sources (workspace_id, github_installation_id)
  WHERE github_installation_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['github_installations', 'github_installation_states'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION skillplane_fence_workspace_migration_write()',
      t || '_migration_fence', t);
  END LOOP;
END; $$;
