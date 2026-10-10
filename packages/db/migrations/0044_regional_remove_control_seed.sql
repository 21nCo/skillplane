-- skillplane:roles=regional
-- Migration 0018 predates physical database roles and seeds a global public
-- stats row even when a fresh regional cell contains no workspace data. Remove
-- that known control-owned seed before topology provisioning checks the cell
-- for real global data and drops all control tables.

DELETE FROM public_stats_counters
 WHERE id = 'global'
   AND agent_skill_uses = 0;
