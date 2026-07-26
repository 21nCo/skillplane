import { resolveMigrationDatabaseUrl } from "./database-url.js";
import { verifyDatabase } from "./verify.js";

const databaseUrl = await resolveMigrationDatabaseUrl();
const result = await verifyDatabase(databaseUrl);
process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
