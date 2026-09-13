-- skillplane:roles=combined,regional
CREATE OR REPLACE FUNCTION skillplane_protect_verification_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > now() THEN RAISE EXCEPTION 'verification run has not expired' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.expires_at <= now() OR OLD.status <> 'running' OR
    to_jsonb(OLD) - ARRAY['status','completed_at','evidence_manifest_digest'] IS DISTINCT FROM
    to_jsonb(NEW) - ARRAY['status','completed_at','evidence_manifest_digest'] THEN
    RAISE EXCEPTION 'verification target and completed runs are immutable' USING ERRCODE='55000';
  END IF;
  IF NEW.status <> 'running' AND (NEW.completed_at IS NULL OR NEW.evidence_manifest_digest IS NULL OR NEW.evidence_manifest_digest !~ '^sha256:[a-f0-9]{64}$' OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.plan->'claims') c WHERE NOT EXISTS
        (SELECT 1 FROM skill_verification_claim_results r WHERE r.run_id=NEW.id AND r.namespaced_claim_id=c->>'namespacedId' AND r.originating_version_id=c->>'originatingVersionId'))) THEN
    RAISE EXCEPTION 'completion requires a manifest and every planned claim result' USING ERRCODE='55000';
  END IF;
  IF NEW.status = 'running' AND (NEW.completed_at IS NOT NULL OR NEW.evidence_manifest_digest IS NOT NULL) THEN
    RAISE EXCEPTION 'running verification cannot have completion metadata' USING ERRCODE='55000';
  END IF;
  IF NEW.status <> 'running' AND NEW.status IS DISTINCT FROM (
    SELECT CASE WHEN bool_or(r.status='fail') THEN 'fail'
      WHEN bool_or(r.status IS NULL OR r.status='unknown' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(c->'requiredEvidence') AS required(kind) WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.evidence) AS ev(value) WHERE ev.value->>'type'=required.kind))) THEN 'unknown' ELSE 'pass' END
    FROM jsonb_array_elements(NEW.plan->'claims') c LEFT JOIN skill_verification_claim_results r ON r.run_id=NEW.id AND r.namespaced_claim_id=c->>'namespacedId'
    WHERE c->>'severity'='blocking'
  ) THEN RAISE EXCEPTION 'completion status does not match claim evidence' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_verification_runs_protect BEFORE UPDATE OR DELETE ON skill_verification_runs FOR EACH ROW EXECUTE FUNCTION skillplane_protect_verification_run();
CREATE OR REPLACE FUNCTION skillplane_protect_verification_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_state text; expiry timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND (OLD.workspace_id,OLD.run_id,OLD.namespaced_claim_id,OLD.originating_version_id) IS DISTINCT FROM (NEW.workspace_id,NEW.run_id,NEW.namespaced_claim_id,NEW.originating_version_id) THEN
    RAISE EXCEPTION 'verification evidence identity is immutable' USING ERRCODE='55000';
  END IF;
  SELECT status,expires_at INTO run_state,expiry FROM skill_verification_runs WHERE id=COALESCE(NEW.run_id,OLD.run_id) FOR SHARE;
  IF TG_OP='DELETE' AND expiry <= now() THEN RETURN OLD; END IF;
  IF run_state IS DISTINCT FROM 'running' OR expiry <= now() THEN RAISE EXCEPTION 'completed or expired verification evidence is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_verification_results_protect BEFORE INSERT OR UPDATE OR DELETE ON skill_verification_claim_results FOR EACH ROW EXECUTE FUNCTION skillplane_protect_verification_result();
