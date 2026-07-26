ALTER TABLE audit_events
  DROP CONSTRAINT audit_events_agent_identity,
  ADD CONSTRAINT audit_events_agent_identity CHECK (
    (agent IS NULL AND model IS NULL)
    OR (agent IS NOT NULL AND model IS NOT NULL)
  );

COMMENT ON CONSTRAINT audit_events_agent_identity ON audit_events IS
  'Caller-declared agent and model are paired; authenticated user identity remains nullable for organization-owned service principals.';
