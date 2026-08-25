CREATE INDEX audit_events_public_agent_skill_use_idx
  ON audit_events (workspace_id, occurred_at, id)
  WHERE action = 'skill_retrieve' AND outcome = 'success';

COMMENT ON INDEX audit_events_public_agent_skill_use_idx IS
  'Supports cached global agent skill-use totals without scanning unrelated audit events.';
