import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { packageRoot } from "./database-url.js";

import { resolve } from "node:path";
import { physicalOwnershipPlan } from "@skillplane/control-plane/table-ownership";

export { physicalOwnershipPlan } from "@skillplane/control-plane/table-ownership";

const migrationsDirectory = resolve(packageRoot, "migrations");
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const migrationRolesPattern =
  /^-- skillplane:roles=(combined|control|regional)(?:,(combined|control|regional))*$/mu;

export type MigrationRole = "combined" | "control" | "regional";

export interface Migration {
  readonly id: string;
  readonly sha256: string;
  readonly sql: string;
  readonly roles: readonly MigrationRole[];
}

export interface MigrationResult {
  readonly role: MigrationRole;
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export function parseWorkspaceRegions(
  value: string | undefined,
): readonly string[] | undefined {
  return value === undefined || value.trim() === ""
    ? undefined
    : value.split(",").map((region) => region.trim());
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function loadMigrations(
  directory = migrationsDirectory,
): Promise<readonly Migration[]> {
  const names = (await readdir(directory))
    .filter((name) => migrationPattern.test(name))
    .sort();
  if (names.length === 0) {
    throw new Error(`No migrations found in ${directory}`);
  }
  return Promise.all(
    names.map(async (id) => {
      const sql = await readFile(resolve(directory, id), "utf8");
      const declaration = migrationRolesPattern.exec(sql)?.[0];
      const roles = declaration
        ? (declaration
            .slice("-- skillplane:roles=".length)
            .split(",") as MigrationRole[])
        : (["combined", "control", "regional"] satisfies MigrationRole[]);
      return {
        id,
        sha256: createHash("sha256").update(sql).digest("hex"),
        sql,
        roles,
      };
    }),
  );
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS skillplane_schema_migrations (
      id text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL CHECK (execution_ms >= 0)
    )
  `);
}

export async function listDatafnTables(
  client: Pool | PoolClient,
): Promise<readonly string[]> {
  const result = await client.query<{ table_name: string }>(
    `SELECT table_name
         FROM information_schema.tables AS candidate
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
          AND (
            left(table_name, 9) = '__datafn_'
            OR EXISTS (
              SELECT 1
                FROM information_schema.columns AS column_definition
               WHERE column_definition.table_schema = candidate.table_schema
                 AND column_definition.table_name = candidate.table_name
                 AND column_definition.column_name = '__ns'
            )
          )
        ORDER BY table_name`,
  );
  return result.rows.map((row) => row.table_name);
}

async function enforcePhysicalOwnership(
  client: PoolClient,
  role: Exclude<MigrationRole, "combined">,
): Promise<void> {
  const plan = physicalOwnershipPlan(role, await listDatafnTables(client));
  if (role === "regional") {
    await client.query(
      "DROP TRIGGER IF EXISTS audit_events_public_stats_counter_insert ON audit_events",
    );
    await client.query(
      "DROP FUNCTION IF EXISTS skillplane_increment_public_agent_skill_uses()",
    );
  }
  for (const table of plan.unowned) {
    await client.query(`DROP TABLE IF EXISTS ${quoteIdentifier(table)} CASCADE`);
  }
  const expected = new Set<string>(plan.expected);
  const actual = await client.query<{ table_name: string }>(
    `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          AND table_name <> 'skillplane_schema_migrations'
        ORDER BY table_name`,
  );
  const unexpected = actual.rows
    .map((row) => row.table_name)
    .filter((table) => !expected.has(table));
  const missing = [...expected].filter(
    (table) => !actual.rows.some((row) => row.table_name === table),
  );
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `DATABASE_OWNERSHIP_INVALID:${role}:unexpected=${unexpected.join(",")}:missing=${missing.join(",")}`,
    );
  }
}

export async function migrateDatabase(
  databaseUrl: string,
  options: {
    readonly role?: MigrationRole;
    readonly initialWorkspaceRegion?: string;
    readonly workspaceRegions?: readonly string[];
    readonly finalizePhysicalOwnership?: boolean;
  } = {},
): Promise<MigrationResult> {
  const role = options.role ?? "combined";
  const initialWorkspaceRegion =
    options.initialWorkspaceRegion ?? (role === "combined" ? "legacy" : undefined);
  if (
    initialWorkspaceRegion !== undefined &&
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(initialWorkspaceRegion)
  ) {
    throw new Error("INITIAL_WORKSPACE_REGION_INVALID");
  }
  if (
    options.workspaceRegions !== undefined &&
    (options.workspaceRegions.length === 0 ||
      new Set(options.workspaceRegions).size !== options.workspaceRegions.length ||
      options.workspaceRegions.some(
        (region) => !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(region),
      ))
  ) {
    throw new Error("WORKSPACE_REGIONS_INVALID");
  }
  if (role === "control" && initialWorkspaceRegion === undefined) {
    throw new Error("INITIAL_WORKSPACE_REGION_REQUIRED");
  }
  if (
    role === "control" &&
    initialWorkspaceRegion !== "legacy" &&
    options.workspaceRegions === undefined
  ) {
    throw new Error("WORKSPACE_REGIONS_REQUIRED");
  }
  if (
    initialWorkspaceRegion !== undefined &&
    options.workspaceRegions !== undefined &&
    !options.workspaceRegions.includes(initialWorkspaceRegion)
  ) {
    throw new Error("INITIAL_WORKSPACE_REGION_UNDECLARED");
  }
  const migrations = (await loadMigrations()).filter(
    (migration) => role === "combined" || migration.roles.includes(role),
  );
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "skillplane-migrator",
    max: 1,
  });
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    if (initialWorkspaceRegion !== undefined) {
      await client.query(
        "SELECT set_config('skillplane.initial_workspace_region', $1, false)",
        [initialWorkspaceRegion],
      );
    }
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [
      "skillplane-schema-migrations-v1",
    ]);
    await ensureLedger(client);
    const ledger = await client.query<{ id: string; sha256: string }>(
      "SELECT id, sha256 FROM skillplane_schema_migrations ORDER BY id",
    );
    const known = new Map(ledger.rows.map((row) => [row.id, row.sha256]));

    await client.query("BEGIN");
    try {
      for (const migration of migrations) {
        const previousHash = known.get(migration.id);
        if (previousHash !== undefined) {
          if (previousHash !== migration.sha256) {
            throw new Error(
              `Applied migration ${migration.id} no longer matches its recorded hash`,
            );
          }
          alreadyApplied.push(migration.id);
          continue;
        }
        const startedAt = performance.now();
        // 0044 was published before accounting for regional databases whose
        // physical-ownership pass had already dropped this control table.
        // Preserve the immutable migration hash, but ledger its intended no-op
        // instead of executing the now-inapplicable DELETE.
        const skipMissingRegionalControlSeed =
          role === "regional" &&
          migration.id === "0044_regional_remove_control_seed.sql" &&
          (
            await client.query<{ relation: string | null }>(
              "SELECT to_regclass('public.public_stats_counters')::text AS relation",
            )
          ).rows[0]?.relation === null;
        if (!skipMissingRegionalControlSeed) {
          await client.query(migration.sql);
        }
        await client.query(
          `INSERT INTO skillplane_schema_migrations
             (id, sha256, execution_ms)
           VALUES ($1, $2, $3)`,
          [
            migration.id,
            migration.sha256,
            Math.max(0, Math.round(performance.now() - startedAt)),
          ],
        );
        applied.push(migration.id);
      }
      if (role === "control" && initialWorkspaceRegion !== undefined) {
        const workspaceRegions = options.workspaceRegions ?? [initialWorkspaceRegion];
        // Disable only regions absent from the configured set. Transiently
        // disabling a retained region queues a deferred `enabled = false` row
        // image that `workspace_regions_protect_placements` rejects at commit
        // whenever that region still has placements, even though the final
        // state re-enables it. Truly removed regions that still hold placements
        // remain correctly rejected.
        await client.query(
          `UPDATE workspace_regions
              SET enabled = false, updated_at = now()
            WHERE region_id <> ALL($1::text[])`,
          [workspaceRegions],
        );
        await client.query(
          `INSERT INTO workspace_regions (region_id, enabled, updated_at)
           SELECT region_id, true, now()
             FROM unnest($1::text[]) AS region(region_id)
           ON CONFLICT (region_id)
           DO UPDATE SET enabled = true, updated_at = now()`,
          [workspaceRegions],
        );
        await client.query(
          `UPDATE workspace_placements
              SET region_id = $1, updated_at = now()
            WHERE region_id = 'legacy'`,
          [initialWorkspaceRegion],
        );
      }
      // Validate the placement region foreign keys (added NOT VALID in 0043)
      // now that the declared regions are reconciled. On a populated
      // pre-control-plane upgrade the constraint would otherwise abort mid-loop
      // when 0043 scanned placements already remapped to a not-yet-seeded
      // region. Only pending (unvalidated) constraints are scanned, so steady
      // state reruns stay cheap.
      if (role !== "regional") {
        const pendingConstraints = await client.query<{ conname: string }>(
          `SELECT conname
             FROM pg_constraint
            WHERE conrelid = to_regclass('public.workspace_placements')
              AND conname IN (
                'workspace_placements_region_id_fkey',
                'workspace_placements_moving_to_region_id_fkey'
              )
              AND NOT convalidated
            ORDER BY conname`,
        );
        for (const { conname } of pendingConstraints.rows) {
          await client.query(
            `ALTER TABLE workspace_placements VALIDATE CONSTRAINT ${quoteIdentifier(conname)}`,
          );
        }
      }
      if (role !== "combined" && options.finalizePhysicalOwnership !== false) {
        await enforcePhysicalOwnership(client, role);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    return { role, applied, alreadyApplied };
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [
        "skillplane-schema-migrations-v1",
      ])
      .catch(() => undefined);
    client.release();
    await pool.end();
  }
}
