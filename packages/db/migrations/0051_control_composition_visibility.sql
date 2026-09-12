-- skillplane:roles=combined,control
-- Only a causally newer public projection can restore visibility.
ALTER TABLE public_skill_version_lifecycle ADD COLUMN withdrawn_sequence bigint CHECK (withdrawn_sequence >= 0);
