import { resolveMigrationDatabaseUrl } from "./database-url.js";
import { migrateDatabase } from "./migrate.js";

const databaseUrl = await resolveMigrationDatabaseUrl();
const result = await migrateDatabase(databaseUrl);
process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
