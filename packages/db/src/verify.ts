import { Pool } from "pg";
import {
  assertAuthfnCoreSchemaContract,
  assertAuthfnPluginSchemaContract,
} from "./authfn.js";
import { loadMigrations } from "./migrate.js";
import type { MigrationRole } from "./migrate.js";
import {
  GLOBAL_CONTROL_TABLES,
  REGIONAL_WORKSPACE_TABLES,
} from "@skillplane/control-plane/table-ownership";

export const REQUIRED_TABLES = [
  ...GLOBAL_CONTROL_TABLES,
  ...REGIONAL_WORKSPACE_TABLES,
  "skillplane_schema_migrations",
] as const;

const REQUIRED_CONSTRAINTS = [
  "context_knowledge_agent_attribution",
  "context_notes_current_revision_tenant_fk",
  "skill_contexts_current_knowledge_tenant_fk",
  "skill_versions_agent_attribution",
  "skills_current_version_tenant_fk",
  "workspaces_tenant_identity",
] as const;

const REQUIRED_TRIGGERS = [
  "audit_events_immutable",
  "audit_events_public_stats_counter_insert",
  "context_knowledge_revisions_immutable",
  "context_note_revisions_immutable",
  "context_notes_current_revision_valid",
  "skill_contexts_current_knowledge_valid",
  "skill_version_files_protect_published",
  "skill_versions_protect_published",
  "skill_contexts_refresh_search",
  "skills_current_version_valid",
] as const;

interface QueryPlan {
  readonly Plan?: Readonly<Record<string, unknown>>;
}

function collectIndexNames(node: unknown, names: Set<string>): void {
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record["Index Name"] === "string") {
    names.add(record["Index Name"]);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) collectIndexNames(item, names);
    } else if (typeof value === "object") {
      collectIndexNames(value, names);
    }
  }
}

async function explain(
  pool: Pool,
  sql: string,
  values: readonly unknown[],
): Promise<readonly string[]> {
  const result = await pool.query<{ "QUERY PLAN": QueryPlan[] }>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    [...values],
  );
  const names = new Set<string>();
  collectIndexNames(result.rows[0]?.["QUERY PLAN"], names);
  return [...names].sort();
}

export interface DatabaseVerification {
  readonly tables: readonly string[];
  readonly constraints: readonly string[];
  readonly triggers: readonly string[];
  readonly migrations: readonly string[];
  readonly queryPlans: Readonly<Record<string, readonly string[]>>;
}

export async function verifyDatabase(
  databaseUrl: string,
  options: { readonly role?: MigrationRole } = {},
): Promise<DatabaseVerification> {
  const role = options.role ?? "combined";
  if (role !== "regional") {
    assertAuthfnCoreSchemaContract();
    assertAuthfnPluginSchemaContract();
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: "skillplane-db-verifier",
    max: 1,
  });
  try {
    const tableResult = await pool.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name`,
    );
    const tables = tableResult.rows.map((row) => row.table_name);
    const requiredTables = [
      ...(role === "regional" ? [] : GLOBAL_CONTROL_TABLES),
      ...(role === "control" ? [] : REGIONAL_WORKSPACE_TABLES),
      "skillplane_schema_migrations",
    ];
    const missingTables = requiredTables.filter((table) => !tables.includes(table));
    if (missingTables.length > 0) {
      throw new Error(`Missing required tables: ${missingTables.join(", ")}`);
    }

    const constraintResult = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint ORDER BY conname`,
    );
    const constraints = constraintResult.rows.map((row) => row.conname);
    const requiredConstraints = REQUIRED_CONSTRAINTS.filter((name) =>
      role === "combined"
        ? true
        : role === "control"
          ? name === "workspaces_tenant_identity"
          : name !== "workspaces_tenant_identity",
    );
    const missingConstraints = requiredConstraints.filter(
      (name) => !constraints.includes(name),
    );
    if (missingConstraints.length > 0) {
      throw new Error(`Missing required constraints: ${missingConstraints.join(", ")}`);
    }

    const triggerResult = await pool.query<{ tgname: string }>(
      `SELECT tgname
         FROM pg_trigger
        WHERE NOT tgisinternal
        ORDER BY tgname`,
    );
    const triggers = triggerResult.rows.map((row) => row.tgname);
    const requiredTriggers =
      role === "control"
        ? []
        : REQUIRED_TRIGGERS.filter(
            (name) =>
              role === "combined" ||
              name !== "audit_events_public_stats_counter_insert",
          );
    const missingTriggers = requiredTriggers.filter((name) => !triggers.includes(name));
    if (missingTriggers.length > 0) {
      throw new Error(`Missing required triggers: ${missingTriggers.join(", ")}`);
    }

    const migrations = (await loadMigrations()).filter(
      (migration) => role === "combined" || migration.roles.includes(role),
    );
    const migrationResult = await pool.query<{ id: string; sha256: string }>(
      "SELECT id, sha256 FROM skillplane_schema_migrations ORDER BY id",
    );
    for (const migration of migrations) {
      const applied = migrationResult.rows.find((row) => row.id === migration.id);
      if (applied?.sha256 !== migration.sha256) {
        throw new Error(`Migration ledger mismatch for ${migration.id}`);
      }
    }

    await pool.query("SET enable_seqscan = off");
    const queryPlans: Record<string, readonly string[]> = {};
    if (role !== "regional") {
      queryPlans.workspaceSlug = await explain(
        pool,
        "SELECT id FROM workspaces WHERE slug = $1",
        ["example"],
      );
      queryPlans.servicePrincipalApiKey = await explain(
        pool,
        `SELECT id FROM service_principals
          WHERE authfn_api_key_id = $1
          LIMIT 1`,
        ["key_example"],
      );
    }
    if (role !== "control") {
      queryPlans.skillSlug = await explain(
        pool,
        "SELECT id FROM skills WHERE workspace_id = $1 AND slug = $2",
        ["workspace:example", "pr-review"],
      );
      queryPlans.skillRevision = await explain(
        pool,
        `SELECT id FROM skill_versions
          WHERE workspace_id = $1 AND skill_id = $2
          ORDER BY revision DESC LIMIT 1`,
        ["workspace:example", "skill:example"],
      );
      queryPlans.contextSlug = await explain(
        pool,
        `SELECT id FROM skill_contexts
          WHERE workspace_id = $1 AND skill_id = $2 AND slug = $3`,
        ["workspace:example", "skill:example", "project"],
      );
      queryPlans.publicSkillSearch = await explain(
        pool,
        `SELECT id FROM skills
          WHERE visibility = 'public'
            AND archived_at IS NULL
            AND current_published_version_id IS NOT NULL
            AND public_search_document @@ plainto_tsquery('simple', $1)
          LIMIT 20`,
        ["pull request"],
      );
      queryPlans.workspaceSkillSearch = await explain(
        pool,
        `SELECT id FROM skills
          WHERE archived_at IS NULL
            AND workspace_search_document @@ plainto_tsquery('simple', $1)
          LIMIT 20`,
        ["pull request"],
      );
      queryPlans.auditExplorer = await explain(
        pool,
        `SELECT id FROM audit_events
          WHERE workspace_id = $1
            AND action = $2
            AND outcome = $3
            AND occurred_at >= $4
          ORDER BY occurred_at DESC, id DESC
          LIMIT 100`,
        ["workspace:example", "skill_retrieve", "success", new Date(0)],
      );
      queryPlans.analyticsSummary = await explain(
        pool,
        `SELECT day, retrieval_count
           FROM analytics_daily_summary
          WHERE workspace_id = $1 AND skill_id = $2 AND day >= $3
          ORDER BY day`,
        ["workspace:example", "", "2026-01-01"],
      );
    }
    for (const [name, indexes] of Object.entries(queryPlans)) {
      if (indexes.length === 0) {
        throw new Error(`Query plan "${name}" does not use an index`);
      }
    }
    if (
      (role !== "control" &&
        (!queryPlans.publicSkillSearch?.includes("skills_public_search_idx") ||
          !queryPlans.workspaceSkillSearch?.includes("skills_workspace_search_idx"))) ||
      (role !== "regional" &&
        !queryPlans.servicePrincipalApiKey?.includes(
          "service_principals_authfn_api_key_unique",
        ))
    ) {
      throw new Error(
        "Required query plans do not use their credential/search indexes",
      );
    }

    return {
      tables,
      constraints,
      triggers,
      migrations: migrationResult.rows.map((row) => row.id),
      queryPlans,
    };
  } finally {
    await pool.end();
  }
}
