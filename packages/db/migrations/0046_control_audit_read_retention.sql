-- skillplane:roles=combined,control
ALTER TABLE control_plane_audit_events
  ADD COLUMN retention_class text NOT NULL DEFAULT 'permanent'
  CONSTRAINT control_plane_audit_retention_valid
    CHECK (retention_class IN ('permanent', 'detailed_read_90d'));
-- Earlier global MCP reads lost their retention classification at insertion.
UPDATE control_plane_audit_events SET retention_class = 'detailed_read_90d'
 WHERE channel = 'mcp' AND action = 'workspaces_list';
CREATE INDEX control_plane_audit_retention_idx
  ON control_plane_audit_events(retention_class, occurred_at);
