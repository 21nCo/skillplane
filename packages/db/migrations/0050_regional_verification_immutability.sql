-- skillplane:roles=combined,regional
CREATE OR REPLACE FUNCTION skillplane_protect_verification_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > now() THEN RAISE EXCEPTION 'verification run has not expired' USING ERRCODE='55000'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'running' OR
    to_jsonb(OLD) - ARRAY['status','completed_at','evidence_manifest_digest'] IS DISTINCT FROM
    to_jsonb(NEW) - ARRAY['status','completed_at','evidence_manifest_digest'] THEN
    RAISE EXCEPTION 'verification target and completed runs are immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_verification_runs_protect BEFORE UPDATE OR DELETE ON skill_verification_runs FOR EACH ROW EXECUTE FUNCTION skillplane_protect_verification_run();
CREATE OR REPLACE FUNCTION skillplane_protect_verification_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_state text; expiry timestamptz;
BEGIN
  SELECT status,expires_at INTO run_state,expiry FROM skill_verification_runs WHERE id=COALESCE(NEW.run_id,OLD.run_id) FOR SHARE;
  IF TG_OP='DELETE' AND expiry <= now() THEN RETURN OLD; END IF;
  IF run_state IS DISTINCT FROM 'running' OR expiry <= now() THEN RAISE EXCEPTION 'completed or expired verification evidence is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER skill_verification_results_protect BEFORE INSERT OR UPDATE OR DELETE ON skill_verification_claim_results FOR EACH ROW EXECUTE FUNCTION skillplane_protect_verification_result();
