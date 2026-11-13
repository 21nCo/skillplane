#!/usr/bin/env node

import {
  developmentDatabase,
  verifiedDevelopmentCloudflareEnvironment,
} from "./lib/development-deployment.mjs";
import { isMain, root, run } from "./lib/production-deployment.mjs";

export async function migrateDevelopment(options = {}) {
  await verifiedDevelopmentCloudflareEnvironment(options);
  const database = options.database ?? developmentDatabase();
  const execute = options.run ?? run;
  execute("pnpm", ["--filter", "@skillplane/db", "migrate"], {
    cwd: root,
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: database.url,
      DATABASE_URL: "",
      SKILLPLANE_DATABASE_ROLE: "combined",
    },
    failureMessage: "Development database migration failed",
  });
  execute("pnpm", ["--filter", "@skillplane/db", "verify"], {
    cwd: root,
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: database.url,
      DATABASE_URL: "",
      SKILLPLANE_DATABASE_ROLE: "combined",
    },
    failureMessage: "Development database verification failed",
  });
  return {
    ok: true,
    environment: "development",
    databaseFingerprint: database.fingerprint,
  };
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await migrateDevelopment(), null, 2)}\n`);
}
