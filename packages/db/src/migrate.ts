import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { packageRoot } from "./database-url.js";

import { resolve } from "node:path";

const migrationsDirectory = resolve(packageRoot, "migrations");
const migrationPattern = /^\d{4}_[a-z0-9_]+\.sql$/;
const migrationRolesPattern =
  /^-- skillplane:roles=(combined|control|regional)(?:,(combined|control|regional))*$/mu;

export type MigrationRole = "combined" | "control" | "regional";

const globalControlTables = [
  "authfn_users",
  "authfn_sessions",
  "authfn_otp_challenges",
  "authfn_api_keys",
  "authfn_region_profiles",
  "authfn_identity_placements",
  "authfn_oauth_clients",
  "authfn_oauth_client_redirect_uris",
  "authfn_oauth_consents",
  "authfn_oauth_authorization_requests",
  "authfn_oauth_authorization_codes",
  "authfn_oauth_access_tokens",
  "authfn_oauth_refresh_tokens",
  "workspaces",
  "workspace_memberships",
  "workspace_invitations",
  "service_principals",
  "workspace_placements",
  "resource_routing_directory",
  "permission_directory_records",
  "workspace_routing_nonces",
  "public_skill_projections",
  "workspace_migration_runs",
  "topology_cutover_state",
  "control_plane_audit_events",
  "control_plane_outbox",
  "public_stats_counters",
  "public_stats_projection_events",
  "api_rate_limits",
] as const;

const regionalWorkspaceTables = [
  "skills",
  "skill_versions",
  "skill_version_files",
  "skill_contexts",
  "context_knowledge_revisions",
  "context_notes",
  "context_note_revisions",
  "amendment_reviews",
  "audit_events",
  "analytics_daily",
  "analytics_daily_summary",
  "analytics_daily_dimensions",
  "analytics_rollup_runs",
  "idempotency_records",
  "regional_projection_outbox",
] as const;

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

export function physicalOwnershipPlan(
  role: Exclude<MigrationRole, "combined">,
  datafnTables: readonly string[],
): {
  readonly unowned: readonly string[];
  readonly expected: readonly string[];
} {
  const staticTables = new Set<string>([
    ...globalControlTables,
    ...regionalWorkspaceTables,
    "skillplane_schema_migrations",
  ]);
  const dynamic = [...new Set(datafnTables)]
    .filter((table) => !staticTables.has(table))
    .sort();
  return role === "control"
    ? {
        unowned: [...regionalWorkspaceTables, ...dynamic],
        expected: [...globalControlTables],
      }
    : {
        unowned: [...globalControlTables],
        expected: [...regionalWorkspaceTables, ...dynamic],
      };
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

async function enforcePhysicalOwnership(
  client: PoolClient,
  role: Exclude<MigrationRole, "combined">,
): Promise<void> {
  await client.query("BEGIN");
  try {
    const datafnTables = await client.query<{ table_name: string }>(
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
    const plan = physicalOwnershipPlan(
      role,
      datafnTables.rows.map((row) => row.table_name),
    );
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
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function migrateDatabase(
  databaseUrl: string,
  options: {
    readonly role?: MigrationRole;
    readonly initialWorkspaceRegion?: string;
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
  if (role === "control" && initialWorkspaceRegion === undefined) {
    throw new Error("INITIAL_WORKSPACE_REGION_REQUIRED");
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
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
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
        await client.query("COMMIT");
        applied.push(migration.id);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    if (role === "control" && initialWorkspaceRegion !== undefined) {
      await client.query(
        `UPDATE workspace_placements
            SET region_id = $1, updated_at = now()
          WHERE region_id = 'legacy'`,
        [initialWorkspaceRegion],
      );
    }
    if (role !== "combined" && options.finalizePhysicalOwnership !== false) {
      await enforcePhysicalOwnership(client, role);
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
