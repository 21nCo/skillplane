-- skillplane:roles=combined,control
-- Preserve the recorded 0046 migration and complete the cleanup ordering index.
DROP INDEX control_plane_audit_retention_idx;
CREATE INDEX control_plane_audit_retention_idx
  ON control_plane_audit_events(retention_class, occurred_at, id);
