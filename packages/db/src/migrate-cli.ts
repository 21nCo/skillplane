import { resolveMigrationDatabaseUrl } from "./database-url.js";
import { migrateDatabase, parseWorkspaceRegions } from "./migrate.js";

const databaseUrl = await resolveMigrationDatabaseUrl();
const role = process.env.SKILLPLANE_DATABASE_ROLE;
if (!role || !["combined", "control", "regional"].includes(role)) {
  throw new Error("SKILLPLANE_DATABASE_ROLE must be combined, control, or regional");
}
// Only the control role declares the routable region set. Forwarding it to a
// combined migration (whose initial region defaults to `legacy`) would trip the
// INITIAL_WORKSPACE_REGION_UNDECLARED guard and fail an otherwise valid migration.
const workspaceRegions =
  role === "control"
    ? parseWorkspaceRegions(process.env.SKILLPLANE_WORKSPACE_REGIONS)
    : undefined;
const result = await migrateDatabase(databaseUrl, {
  role: role as "combined" | "control" | "regional",
  ...(process.env.SKILLPLANE_INITIAL_WORKSPACE_REGION
    ? { initialWorkspaceRegion: process.env.SKILLPLANE_INITIAL_WORKSPACE_REGION }
    : {}),
  ...(workspaceRegions ? { workspaceRegions } : {}),
});
process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
