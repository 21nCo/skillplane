#!/usr/bin/env node

import { migrateDatabase } from "../packages/db/dist/src/index.js";
import { isMain, requireEnvironment } from "./lib/production-deployment.mjs";
import { readProductionTopology } from "./lib/topology-deployment.mjs";

function regionEnvironment(regionId) {
  return `SKILLPLANE_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_DATABASE_URL`;
}

export async function migrateTopologyDatabases(options = {}) {
  const manifest = options.manifest ?? (await readProductionTopology());
  const controlUrl =
    options.controlDatabaseUrl ?? requireEnvironment("SKILLPLANE_CONTROL_DATABASE_URL");
  const initialWorkspaceRegion = manifest.cells[0]?.regionId;
  if (!initialWorkspaceRegion) {
    throw new Error("The topology must declare an initial workspace cell");
  }
  const control = await migrateDatabase(controlUrl, {
    role: "control",
    initialWorkspaceRegion,
  });
  const cells = {};
  for (const cell of manifest.cells) {
    cells[cell.regionId] = await migrateDatabase(
      options.cells?.[cell.regionId] ??
        requireEnvironment(regionEnvironment(cell.regionId)),
      { role: "regional" },
    );
  }
  return { ok: true, control, cells };
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await migrateTopologyDatabases(), null, 2)}\n`,
  );
}
