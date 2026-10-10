CREATE OR REPLACE FUNCTION skillplane_protect_published_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published skill versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION skillplane_protect_published_version() IS
  'Allows the one-way draft-to-published transition, then rejects all updates and deletes.';
