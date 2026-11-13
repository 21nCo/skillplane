#!/usr/bin/env node

import { migrateDatabase } from "../packages/db/dist/src/migrate.js";
import {
  assertDevelopmentTopologyPrepared,
  assertProductionIsolationConfigured,
  developmentInitialWorkspaceRegion,
  developmentTopologyDatabases,
  verifyDevelopmentTopologyDatabases,
} from "./lib/development-topology-deployment.mjs";
import { verifiedDevelopmentCloudflareEnvironment } from "./lib/development-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";

// Brings the development control database and every development cell to the
// code's migration head in place. Unlike `db:prepare:dev:topology`, it never
// converts, drops, or prunes tables, and it takes no backup: development data
// is disposable, while production keeps `db:migrate:topology`.
export async function migrateDevelopmentTopology(options = {}) {
  // The development Cloudflare token must reach only the development account
  // before any database is parsed or touched.
  await verifiedDevelopmentCloudflareEnvironment(options);
  // Before parsing any URL, the production identities must be configured on
  // every invocation, local or CI. Parsing the topology then refuses any URL
  // that names a production identity or a production URL variable before the
  // first connection.
  let databases = options.databases;
  if (!databases) {
    assertProductionIsolationConfigured();
    databases = developmentTopologyDatabases();
  }
  const migrate = options.migrate ?? migrateDatabase;
  // Checks the databases in order before writing to any: the first empty or
  // unconverted database stops the run with TOPOLOGY_NOT_PREPARED and nothing
  // changes.
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
