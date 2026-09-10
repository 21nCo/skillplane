import { resolveMigrationDatabaseUrl } from "./database-url.js";
import { verifyDatabase } from "./verify.js";

const databaseUrl = await resolveMigrationDatabaseUrl();
const role = process.env.SKILLPLANE_DATABASE_ROLE;
if (!role || !["combined", "control", "regional"].includes(role)) {
  throw new Error("SKILLPLANE_DATABASE_ROLE must be combined, control, or regional");
}
const result = await verifyDatabase(databaseUrl, {
  role: role as "combined" | "control" | "regional",
});
process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
