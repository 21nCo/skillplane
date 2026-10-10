CREATE OR REPLACE FUNCTION skillplane_validate_audit_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  serialized text := NEW.metadata::text;
BEGIN
  IF serialized ~* '"[^"]*(prompt|otp|email|token|secret|password|authorization|cookie)[^"]*"[[:space:]]*:'
     OR serialized ~* '"(body|skillbody|skillcontent|instructions)"[[:space:]]*:'
     OR serialized ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
     OR serialized ~* '(bearer[[:space:]]+[A-Z0-9._~+/-]+=*|sps_[A-Z0-9_-]{12,})' THEN
    RAISE EXCEPTION 'audit metadata contains a prohibited sensitive value'
      USING ERRCODE = '23514',
            CONSTRAINT = 'audit_events_sensitive_metadata';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION skillplane_validate_audit_event() IS
  'Defense-in-depth validation that prevents prompt, body, OTP, email, token, credential, and secret data from bypassing application redaction.';
