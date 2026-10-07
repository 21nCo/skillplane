-- skillplane:roles=combined,regional
CREATE TABLE skill_sources (
 id text PRIMARY KEY, workspace_id text NOT NULL, repository_url text NOT NULL,
 ref text NOT NULL, ref_policy text NOT NULL CHECK(ref_policy IN ('track','pin')),
 skill_path text, revision integer NOT NULL DEFAULT 1, archived_at timestamptz,
 sync_token text, sync_expires_at timestamptz, creation_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id)
);
CREATE TABLE skill_source_runs (
 id text PRIMARY KEY, workspace_id text NOT NULL, source_id text NOT NULL,
 source_revision integer NOT NULL, commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='array'), results jsonb NOT NULL DEFAULT '[]', failure_message text,
 status text NOT NULL DEFAULT 'preview' CHECK(status IN ('preview','partial','complete')),
 created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz,
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,source_id) REFERENCES skill_sources(workspace_id,id)
);
CREATE TABLE skill_source_bindings (
 workspace_id text NOT NULL, source_id text NOT NULL, skill_path text NOT NULL, skill_id text NOT NULL,
 last_commit_sha text, last_digest text, last_version_id text, base_version_id text,
 disconnected_at timestamptz, status text NOT NULL DEFAULT 'bound', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(source_id,skill_path),
 FOREIGN KEY(workspace_id,source_id) REFERENCES skill_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,skill_id) REFERENCES skills(workspace_id,id)
);
CREATE UNIQUE INDEX skill_source_bindings_workspace_skill_unique ON skill_source_bindings(workspace_id,skill_id) WHERE disconnected_at IS NULL;
CREATE TABLE skill_version_git_provenance (
 version_id text PRIMARY KEY, workspace_id text NOT NULL, source_id text NOT NULL, run_id text NOT NULL,
 repository_url text NOT NULL, commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
 skill_path text NOT NULL, bundle_digest text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT skill_version_git_provenance_run_skill_unique UNIQUE(run_id,skill_path),
 FOREIGN KEY(workspace_id,source_id) REFERENCES skill_sources(workspace_id,id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES skill_source_runs(workspace_id,id),
 FOREIGN KEY(workspace_id,version_id) REFERENCES skill_versions(workspace_id,id)
);
CREATE INDEX skill_source_runs_recent_idx ON skill_source_runs(workspace_id,source_id,created_at DESC);
CREATE FUNCTION skillplane_git_provenance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Git version provenance is immutable' USING ERRCODE='55000'; END; $$;
CREATE TRIGGER skill_version_git_provenance_immutable BEFORE UPDATE OR DELETE ON skill_version_git_provenance FOR EACH ROW EXECUTE FUNCTION skillplane_git_provenance_immutable();
CREATE FUNCTION skillplane_git_run_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD.id,OLD.workspace_id,OLD.source_id,OLD.source_revision,OLD.commit_sha,OLD.plan,OLD.created_at) IS DISTINCT FROM (NEW.id,NEW.workspace_id,NEW.source_id,NEW.source_revision,NEW.commit_sha,NEW.plan,NEW.created_at) THEN
 RAISE EXCEPTION 'Git preview identity is immutable' USING ERRCODE='55000'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER skill_source_run_identity_immutable BEFORE UPDATE ON skill_source_runs FOR EACH ROW EXECUTE FUNCTION skillplane_git_run_identity_immutable();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['skill_sources','skill_source_runs','skill_source_bindings','skill_version_git_provenance'] LOOP
 EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION skillplane_fence_workspace_migration_write()',t || '_migration_fence',t); END LOOP; END; $$;
