ALTER TABLE service_principals
  ADD COLUMN authfn_api_key_id text
    REFERENCES authfn_api_keys(id) ON DELETE SET NULL;

ALTER TABLE service_principals
  ALTER COLUMN credential_hash DROP NOT NULL;

ALTER TABLE service_principals
  ADD CONSTRAINT service_principals_single_credential_source CHECK (
    credential_hash IS NULL OR authfn_api_key_id IS NULL
  );

CREATE UNIQUE INDEX service_principals_authfn_api_key_unique
  ON service_principals (authfn_api_key_id)
  WHERE authfn_api_key_id IS NOT NULL;

COMMENT ON COLUMN service_principals.credential_hash IS
  'Legacy sps_ credential hash retained only for the compatibility window.';
COMMENT ON COLUMN service_principals.authfn_api_key_id IS
  'AuthFn API-key actor mapped to this Skillplane service principal.';

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
     OR serialized ~* '(bearer[[:space:]]+[A-Z0-9._~+/-]+=*|sp[sk]_[A-Z0-9_-]{12,})' THEN
    RAISE EXCEPTION 'audit metadata contains a prohibited sensitive value'
      USING ERRCODE = '23514',
            CONSTRAINT = 'audit_events_sensitive_metadata';
  END IF;
  RETURN NEW;
END;
$$;
