-- skillplane:roles=combined,regional
CREATE TABLE skill_groups (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  creation_hash text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id,id)
);
CREATE UNIQUE INDEX skill_groups_workspace_name_unique ON skill_groups(workspace_id,lower(name));
CREATE TABLE skill_group_skills (
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  skill_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id,skill_id),
  FOREIGN KEY (workspace_id,group_id) REFERENCES skill_groups(workspace_id,id),
  FOREIGN KEY (workspace_id,skill_id) REFERENCES skills(workspace_id,id)
);
-- Identity and memberships live in the control database. Membership is checked
-- against that authority by the service; it is never an authorization grant.
CREATE TABLE skill_group_members (
  workspace_id text NOT NULL,
  group_id text NOT NULL,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id,user_id),
  FOREIGN KEY (workspace_id,group_id) REFERENCES skill_groups(workspace_id,id)
);
CREATE INDEX skill_group_skills_skill_idx ON skill_group_skills(workspace_id,skill_id,group_id);
CREATE INDEX skill_group_members_user_idx ON skill_group_members(workspace_id,user_id,group_id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['skill_groups','skill_group_skills','skill_group_members'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION skillplane_fence_workspace_migration_write()',t || '_migration_fence',t);
  END LOOP;
END $$;
