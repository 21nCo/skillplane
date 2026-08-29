import { resolveMigrationDatabaseUrl } from "./database-url.js";
import { migrateDatabase } from "./migrate.js";

const databaseUrl = await resolveMigrationDatabaseUrl();
const role = process.env.SKILLPLANE_DATABASE_ROLE;
if (role && !["combined", "control", "regional"].includes(role)) {
  throw new Error("SKILLPLANE_DATABASE_ROLE must be combined, control, or regional");
}
const result = await migrateDatabase(databaseUrl, {
  role: (role ?? "combined") as "combined" | "control" | "regional",
  ...(process.env.SKILLPLANE_INITIAL_WORKSPACE_REGION
    ? { initialWorkspaceRegion: process.env.SKILLPLANE_INITIAL_WORKSPACE_REGION }
    : {}),
});
process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
