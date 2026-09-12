-- skillplane:roles=combined,control
-- Emergency invalidations are checked independently of immutable public bundles.
CREATE TABLE public_skill_version_lifecycle (
  version_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  deprecated_at timestamptz,
  revoked_at timestamptz,
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX public_skill_version_lifecycle_workspace_idx ON public_skill_version_lifecycle(workspace_id);
