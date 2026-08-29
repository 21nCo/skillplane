#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  PostgresWorkspaceMigrationJournal,
  PostgresWorkspaceMigrationOperations,
  createPostgresWorkspacePlacementDirectory,
  migrateWorkspaceWithJournal,
  runWorkspaceRollbackDrill,
} from "../packages/control-plane/dist/index.js";
import { isMain, requireEnvironment, run } from "./lib/production-deployment.mjs";

function bucketName(name) {
  return requireEnvironment(name, {
    pattern: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u,
  });
}

function objectKey(value) {
  if (!/^workspaces\/[A-Za-z0-9:_/-]{1,900}$/u.test(value)) {
    throw new Error("Workspace bundle object key is invalid");
  }
  return value;
}

class WranglerR2MigrationStore {
  constructor(bucket) {
    this.bucket = bucket;
  }

  async withTemporaryFile(operation) {
    const directory = await mkdtemp(resolve(tmpdir(), "skillplane-workspace-move-"));
    const path = resolve(directory, "bundle.zip");
    try {
      return await operation(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async read(key) {
    return this.withTemporaryFile(async (path) => {
      run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "r2",
          "object",
          "get",
          `${this.bucket}/${objectKey(key)}`,
          "--file",
          path,
          "--remote",
        ],
        { failureMessage: `Could not read ${this.bucket}/${key}` },
      );
      return new Uint8Array(await readFile(path));
    });
  }

  async put(key, bytes) {
    await this.withTemporaryFile(async (path) => {
      await writeFile(path, bytes, { mode: 0o600 });
      run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "r2",
          "object",
          "put",
          `${this.bucket}/${objectKey(key)}`,
          "--file",
          path,
          "--content-type",
          "application/zip",
          "--remote",
        ],
        { failureMessage: `Could not write ${this.bucket}/${key}` },
      );
    });
  }

  async delete(key) {
    run(
      "pnpm",
      [
        "exec",
        "wrangler",
        "r2",
        "object",
        "delete",
        `${this.bucket}/${objectKey(key)}`,
        "--remote",
      ],
      { failureMessage: `Could not delete ${this.bucket}/${key}` },
    );
  }
}

export async function migrateConfiguredWorkspace() {
  const workspaceId = requireEnvironment("SKILLPLANE_WORKSPACE_ID", {
    pattern: /^[A-Za-z0-9:_-]{1,180}$/u,
  });
  const targetRegionId = requireEnvironment("SKILLPLANE_TARGET_REGION_ID", {
    pattern: /^[a-z0-9][a-z0-9-]{0,62}$/u,
  });
  const control = new Pool({
    connectionString: requireEnvironment("SKILLPLANE_CONTROL_DATABASE_URL"),
    application_name: "skillplane-workspace-migration-control",
    max: 2,
  });
  const source = new Pool({
    connectionString: requireEnvironment("SKILLPLANE_SOURCE_DATABASE_URL"),
    application_name: "skillplane-workspace-migration-source",
    max: 2,
  });
  const target = new Pool({
    connectionString: requireEnvironment("SKILLPLANE_TARGET_DATABASE_URL"),
    application_name: "skillplane-workspace-migration-target",
    max: 2,
  });
  try {
    const operations = new PostgresWorkspaceMigrationOperations(
      source,
      target,
      control,
      new WranglerR2MigrationStore(bucketName("SKILLPLANE_SOURCE_BUCKET")),
      new WranglerR2MigrationStore(bucketName("SKILLPLANE_TARGET_BUCKET")),
    );
    const directory = createPostgresWorkspacePlacementDirectory(control);
    await runWorkspaceRollbackDrill({
      directory,
      workspaceId,
      targetRegionId,
      operations,
    });
    return await migrateWorkspaceWithJournal({
      directory,
      journal: new PostgresWorkspaceMigrationJournal(control),
      workspaceId,
      targetRegionId,
      operations,
      rollbackTested: true,
    });
  } finally {
    await Promise.allSettled([source.end(), target.end(), control.end()]);
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify({ ok: true, ...(await migrateConfiguredWorkspace()) }, null, 2)}\n`,
  );
}
