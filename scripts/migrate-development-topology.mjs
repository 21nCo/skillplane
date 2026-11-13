#!/usr/bin/env node

import { migrateDatabase } from "../packages/db/dist/src/migrate.js";
import {
  assertDevelopmentTopologyPrepared,
  developmentInitialWorkspaceRegion,
  developmentTopologyDatabases,
  verifyDevelopmentTopologyDatabases,
} from "./lib/development-topology-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";

// Brings the development control database and every development cell to the
// code's migration head in place. Unlike `db:prepare:dev:topology`, it never
// converts, drops, or prunes tables, and it takes no backup: development data
// is disposable, while production keeps `db:migrate:topology`.
export async function migrateDevelopmentTopology(options = {}) {
  // Parsing the topology refuses any URL that names a production database
  // before the first connection.
  const databases = options.databases ?? developmentTopologyDatabases();
  const migrate = options.migrate ?? migrateDatabase;
  await assertDevelopmentTopologyPrepared(databases);
  // Each call holds the shared schema-migration advisory lock and applies its
  // pending migrations in one transaction, so a racing or retried run either
  // waits and then applies nothing, or resumes from the last committed database.
  // Physical-ownership pruning stays off: it is the step that drops tables.
  const control = await migrate(databases.control.url, {
    role: "control",
    initialWorkspaceRegion: developmentInitialWorkspaceRegion,
    workspaceRegions: Object.keys(databases.cells),
    finalizePhysicalOwnership: false,
  });
  const cells = {};
  for (const [regionId, database] of Object.entries(databases.cells)) {
    cells[regionId] = await migrate(database.url, {
      role: "regional",
      finalizePhysicalOwnership: false,
    });
  }
  const verification = await verifyDevelopmentTopologyDatabases(databases, {
    migrations: options.migrations,
  });
  return {
    ok: true,
    environment: "development",
    control,
    cells,
    ...verification,
  };
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await migrateDevelopmentTopology(), null, 2)}\n`,
  );
}
