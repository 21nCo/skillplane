#!/usr/bin/env node

import { mkdir, open, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  activeWorkerVersion,
  isMain,
  pathExists,
  portablePath,
  productionStateDirectory,
  railwayDatabase,
  readJson,
  root,
  sanitizeDeploymentRecord,
  sha256,
  validateVersionId,
  workers,
  wrangler,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";
import { productionSmoke } from "./production-smoke.mjs";

const releasePath = resolve(productionStateDirectory, "release.json");
const lockPath = resolve(productionStateDirectory, "rollback.lock");

function workerRelease(release, kind) {
  const record = release.workers?.[kind];
  if (!record || record.worker !== workers[kind].name) {
    throw new Error(`The release record for ${kind} is invalid`);
  }
  return {
    priorVersion: validateVersionId(
      record.priorVersion,
      `${record.worker} prior version`,
    ),
    releaseVersion: validateVersionId(
      record.releaseVersion,
      `${record.worker} release version`,
    ),
  };
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function databaseSnapshot() {
  const database = railwayDatabase();
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-production-rollback-verifier",
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const ssl = await pool.query(
      "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
    );
    if (ssl.rows[0]?.ssl !== true) {
      throw new Error("The rollback verification connection is not protected by SSL");
    }
    const tables = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const tableState = {};
    for (const row of tables.rows) {
      const result = await pool.query(
        `SELECT count(*)::text AS count,
                COALESCE(
                  bit_xor(
                    ('x' || substr(md5(row_to_json(value)::text), 1, 16))
                      ::bit(64)::bigint
                  )::text,
                  '0'
                ) AS digest_a,
                COALESCE(
                  bit_xor(
                    ('x' || substr(md5(row_to_json(value)::text), 17, 16))
                      ::bit(64)::bigint
                  )::text,
                  '0'
                ) AS digest_b
           FROM ${quoteIdentifier(row.table_name)} value`,
      );
      tableState[row.table_name] = {
        count: result.rows[0]?.count ?? "0",
        digest: sha256(
          `${result.rows[0]?.digest_a ?? "0"}:${result.rows[0]?.digest_b ?? "0"}`,
        ),
      };
    }
    const migrations = await pool.query(
      "SELECT id, sha256 FROM skillplane_schema_migrations ORDER BY id",
    );
    return {
      databaseFingerprint: database.fingerprint,
      tableState,
      migrationLedgerDigest: sha256(JSON.stringify(migrations.rows)),
      stateDigest: sha256(JSON.stringify({ tableState, migrations: migrations.rows })),
    };
  } finally {
    await pool.end();
  }
}

function rollbackWorker(kind, version, message) {
  const worker = workers[kind];
  wrangler(["rollback", version, "--name", worker.name, "--message", message, "--yes"]);
  const active = activeWorkerVersion(worker);
  if (active !== version) {
    throw new Error(`${worker.name} did not activate the requested version`);
  }
}

export async function verifyProductionRollback() {
  await mkdir(productionStateDirectory, { recursive: true, mode: 0o700 });
  const lock = await open(lockPath, "wx", 0o600).catch((error) => {
    if (error?.code === "EEXIST") {
      throw new Error("Another production rollback rehearsal is already running");
    }
    throw error;
  });
  const startedAt = new Date().toISOString();
  let release;
  let databaseBefore;
  let rollbackSmoke;
  let forwardSmoke;
  let rehearsalError;
  const transitions = [];
  try {
    if (!(await pathExists(releasePath))) {
      throw new Error(
        "A successful production release record is required before rollback",
      );
    }
    release = await readJson(releasePath);
    if (release.ok !== true || typeof release.tag !== "string") {
      throw new Error("A successful production release record is required");
    }
    const inventory = Object.fromEntries(
      Object.keys(workers).map((kind) => [kind, workerRelease(release, kind)]),
    );
    for (const [kind, record] of Object.entries(inventory)) {
      const current = activeWorkerVersion(workers[kind]);
      if (current !== record.releaseVersion) {
        throw new Error(
          `${workers[kind].name} no longer matches the recorded release; refusing to replace a newer deployment`,
        );
      }
    }
    databaseBefore = await databaseSnapshot();
    try {
      for (const kind of ["landing", "mcp", "app"]) {
        rollbackWorker(
          kind,
          inventory[kind].priorVersion,
          `Skillplane rollback rehearsal for ${release.tag}`,
        );
        transitions.push({
          kind,
          direction: "rollback",
          version: inventory[kind].priorVersion,
        });
      }
      rollbackSmoke = await productionSmoke({ attempts: 10 });
    } catch (error) {
      rehearsalError = error;
    }
    const forwardErrors = [];
    for (const kind of ["app", "mcp", "landing"]) {
      try {
        const current = activeWorkerVersion(workers[kind]);
        if (current !== inventory[kind].releaseVersion) {
          rollbackWorker(
            kind,
            inventory[kind].releaseVersion,
            `Skillplane roll-forward restoration for ${release.tag}`,
          );
          transitions.push({
            kind,
            direction: "roll-forward",
            version: inventory[kind].releaseVersion,
          });
        }
      } catch (error) {
        forwardErrors.push(error);
      }
    }
    try {
      forwardSmoke = await productionSmoke({ attempts: 10 });
    } catch (error) {
      forwardErrors.push(error);
    }
    const databaseAfter = await databaseSnapshot();
    if (
      databaseBefore.databaseFingerprint !== databaseAfter.databaseFingerprint ||
      databaseBefore.stateDigest !== databaseAfter.stateDigest
    ) {
      throw new Error("Database row or migration state changed during rollback");
    }
    if (forwardErrors.length > 0) {
      throw new AggregateError(
        forwardErrors,
        "One or more Workers could not be restored and verified at the release version",
      );
    }
    if (rehearsalError) throw rehearsalError;
    const record = sanitizeDeploymentRecord({
      schemaVersion: 1,
      ok: true,
      startedAt,
      completedAt: new Date().toISOString(),
      releaseTag: release.tag,
      releaseManifest: release.manifest,
      workers: inventory,
      transitions,
      rollbackSmoke,
      forwardSmoke,
      database: {
        fingerprint: databaseAfter.databaseFingerprint,
        stateDigest: databaseAfter.stateDigest,
        migrationLedgerDigest: databaseAfter.migrationLedgerDigest,
        tableStateUnchanged: true,
      },
    });
    const artifactPath = resolve(
      root,
      ".conduct",
      "deployments",
      `${startedAt.replaceAll(/[:.]/gu, "-")}-${release.tag}-rollback.json`,
    );
    await writeJsonAtomic(artifactPath, record, {
      mode: 0o600,
      exclusive: true,
    });
    await writeJsonAtomic(
      resolve(productionStateDirectory, "rollback.json"),
      { ...record, artifact: portablePath(artifactPath) },
      { mode: 0o600 },
    );
    return { ...record, artifact: portablePath(artifactPath) };
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await verifyProductionRollback(), null, 2)}\n`,
  );
}
