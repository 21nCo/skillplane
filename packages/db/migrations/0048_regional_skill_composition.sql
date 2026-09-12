-- skillplane:roles=combined,regional
-- Separate immutable composition metadata avoids rewriting historical bundles.
CREATE TABLE skill_version_compositions (
  workspace_id text NOT NULL,
  version_id text PRIMARY KEY,
  format_version integer NOT NULL CHECK (format_version = 2),
  dependency_closure_digest text NOT NULL CHECK (dependency_closure_digest ~ '^sha256:[a-f0-9]{64}$'),
  dependency_lock jsonb NOT NULL CHECK (jsonb_typeof(dependency_lock) = 'object'),
  FOREIGN KEY (workspace_id, version_id) REFERENCES skill_versions(workspace_id,id)
);
CREATE TABLE skill_version_dependencies (
  workspace_id text NOT NULL,
  root_version_id text NOT NULL,
  parent_version_id text NOT NULL,
  alias text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  child_version_id text NOT NULL,
  edge jsonb NOT NULL,
  node jsonb NOT NULL,
  PRIMARY KEY (root_version_id,parent_version_id,alias),
  UNIQUE (root_version_id,parent_version_id,ordinal),
  FOREIGN KEY (workspace_id,root_version_id) REFERENCES skill_versions(workspace_id,id)
);
CREATE INDEX skill_version_dependencies_child_idx ON skill_version_dependencies(child_version_id);
CREATE TABLE skill_version_lifecycle (
  workspace_id text NOT NULL,
  version_id text PRIMARY KEY,
  deprecated_at timestamptz,
  revoked_at timestamptz,
  reason text NOT NULL,
  FOREIGN KEY (workspace_id,version_id) REFERENCES skill_versions(workspace_id,id)
);
CREATE TABLE skill_verification_runs (
  workspace_id text NOT NULL,
  id text PRIMARY KEY,
  version_id text NOT NULL,
  closure_digest text NOT NULL,
  repository text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^([a-f0-9]{40}|[a-f0-9]{64})$'),
  environment text NOT NULL,
  verifier_actor_id text NOT NULL,
  verifier_actor_type text NOT NULL,
  executor_actor_id text NOT NULL,
  agent text NOT NULL,
  model text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','pass','fail','unknown')),
  plan jsonb NOT NULL,
  evidence_manifest_digest text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '90 days',
  UNIQUE(workspace_id,id),
  FOREIGN KEY (workspace_id,version_id) REFERENCES skill_versions(workspace_id,id)
);
CREATE INDEX skill_verification_runs_version_idx ON skill_verification_runs(workspace_id,version_id,started_at DESC);
CREATE TABLE skill_verification_claim_results (
  workspace_id text NOT NULL,
  run_id text NOT NULL,
  namespaced_claim_id text NOT NULL,
  originating_version_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pass','fail','unknown')),
  explanation text NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY(run_id,namespaced_claim_id),
  FOREIGN KEY (workspace_id,run_id) REFERENCES skill_verification_runs(workspace_id,id)
);
CREATE TRIGGER skill_version_compositions_immutable BEFORE UPDATE OR DELETE ON skill_version_compositions FOR EACH ROW EXECUTE FUNCTION skillplane_reject_mutation();
CREATE TRIGGER skill_version_dependencies_immutable BEFORE UPDATE OR DELETE ON skill_version_dependencies FOR EACH ROW EXECUTE FUNCTION skillplane_reject_mutation();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['skill_version_compositions','skill_version_dependencies','skill_version_lifecycle','skill_verification_runs','skill_verification_claim_results'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION skillplane_fence_workspace_migration_write()',t || '_migration_fence',t);
  END LOOP;
END $$;
