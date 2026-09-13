-- skillplane:roles=combined,control
-- Only a causally newer public projection can restore visibility.
ALTER TABLE public_skill_version_lifecycle ADD COLUMN withdrawn_sequence bigint;
ALTER TABLE public_skill_version_lifecycle ADD CONSTRAINT public_skill_version_lifecycle_withdrawn_sequence_check CHECK (withdrawn_sequence >= 0) NOT VALID;
