import type { DatafnNamespaceMigrationContext } from "@datafn/server";
import type { MigrationCheck, WorkspaceMigrationOperations } from "./migration.js";

interface SqlResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface MigrationSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  release(): void;
}

export interface MigrationSqlPool {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<Row>>;
  connect(): Promise<MigrationSqlClient>;
}

type MigrationSqlQueryable = Pick<MigrationSqlPool, "query">;

export interface WorkspaceMigrationObjectStore {
  read(key: string): Promise<Uint8Array>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

const regionalTables = [
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

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("WORKSPACE_MIGRATION_IDENTIFIER_INVALID");
  }
  return `"${value}"`;
}

async function dynamicNamespaceTables(pool: MigrationSqlPool): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = '__ns'
      GROUP BY table_name
      ORDER BY table_name`,
  );
  return result.rows
    .map((row) => row.table_name)
    .filter(
      (table) => !regionalTables.includes(table as (typeof regionalTables)[number]),
    );
}

async function rowsForWorkspace(
  client: MigrationSqlClient,
  table: string,
  workspaceId: string,
  namespaceColumn: "workspace_id" | "__ns",
): Promise<readonly string[]> {
  return (
    await client.query<{ row_json: string }>(
      `SELECT to_jsonb(${identifier(table)})::text AS row_json
         FROM ${identifier(table)}
        WHERE ${identifier(namespaceColumn)} = $1
        ORDER BY to_jsonb(${identifier(table)})::text`,
      [workspaceId],
    )
  ).rows.map((row) => row.row_json);
}

async function insertRows(
  client: MigrationSqlClient,
  table: string,
  rows: readonly string[],
): Promise<void> {
  const writable = await client.query<{
    column_name: string;
  }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND is_generated = 'NEVER' AND is_identity = 'NO'
      ORDER BY ordinal_position`,
    [table],
  );
  for (const row of rows) {
    const columns = writable.rows.map((column) => column.column_name);
    if (columns.length === 0) continue;
    await client.query(
      `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")})
       SELECT ${columns.map(identifier).join(", ")}
         FROM jsonb_populate_record(NULL::${identifier(table)}, $1::jsonb)`,
      [row],
    );
  }
}

async function checksum(
  pool: MigrationSqlQueryable,
  table: string,
  workspaceId: string,
  namespaceColumn: "workspace_id" | "__ns",
): Promise<{ readonly count: string; readonly checksum: string }> {
  const result = await pool.query<{ count: string; checksum: string }>(
    `SELECT count(*)::text AS count,
            md5(COALESCE(string_agg(to_jsonb(row_value)::text, ''
                ORDER BY to_jsonb(row_value)::text), '')) AS checksum
       FROM ${identifier(table)} row_value
      WHERE ${identifier(namespaceColumn)} = $1`,
    [workspaceId],
  );
  return result.rows[0] ?? { count: "0", checksum: "" };
}

async function digest(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy.buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Concrete, retry-safe PostgreSQL and object-store implementation of a fenced move. */
export class PostgresWorkspaceMigrationOperations implements WorkspaceMigrationOperations {
  private quiescedSource: MigrationSqlClient | null = null;

  constructor(
    private readonly source: MigrationSqlPool,
    private readonly target: MigrationSqlPool,
    private readonly control: MigrationSqlPool,
    private readonly sourceObjects: WorkspaceMigrationObjectStore,
    private readonly targetObjects: WorkspaceMigrationObjectStore,
  ) {}

  private async pendingOutboxes(workspaceId: string): Promise<number> {
    const projection = await this.source.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM regional_projection_outbox
        WHERE workspace_id = $1 AND processed_at IS NULL`,
      [workspaceId],
    );
    const outboxExists = await this.source.query<{ present: boolean }>(
      `SELECT to_regclass('public.__datafn_permission_directory_outbox')
                IS NOT NULL AS present`,
    );
    const datafnCount = outboxExists.rows[0]?.present
      ? (
          await this.source.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM __datafn_permission_directory_outbox
              WHERE __ns = $1`,
            [workspaceId],
          )
        ).rows[0]?.count
      : "0";
    return Number(projection.rows[0]?.count ?? "0") + Number(datafnCount ?? "0");
  }

  async prepareSource(workspaceId: string): Promise<void> {
    const deadline = Date.now() + 75_000;
    while ((await this.pendingOutboxes(workspaceId)) > 0) {
      if (Date.now() >= deadline) {
        throw new Error("WORKSPACE_MIGRATION_OUTBOX_NOT_DRAINED");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async quiesceSource(context: DatafnNamespaceMigrationContext): Promise<void> {
    void context;
    if (this.quiescedSource) return;
    const client = await this.source.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const dynamic = await dynamicNamespaceTables(this.source);
      const lockTables = [...regionalTables, ...dynamic].filter(
        (table) =>
          table !== "regional_projection_outbox" &&
          table !== "__datafn_permission_directory_outbox",
      );
      if (lockTables.length > 0) {
        await client.query(
          `LOCK TABLE ${lockTables.map(identifier).join(", ")} IN SHARE MODE`,
        );
      }
      this.quiescedSource = client;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      throw error;
    }
  }

  async drainOutboxes(context: DatafnNamespaceMigrationContext): Promise<void> {
    if ((await this.pendingOutboxes(context.namespace)) !== 0) {
      throw new Error("WORKSPACE_MIGRATION_OUTBOX_NOT_DRAINED");
    }
  }

  async copyDatabase(context: DatafnNamespaceMigrationContext): Promise<void> {
    const source = this.quiescedSource;
    if (!source) throw new Error("WORKSPACE_MIGRATION_SOURCE_NOT_QUIESCED");
    const target = await this.target.connect();
    const dynamic = await dynamicNamespaceTables(this.source);
    try {
      await target.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      // Preserve the source row image exactly. Application triggers derive
      // search fields and timestamps as related rows arrive, which would make
      // a logically identical copy fail the stable checksum. This setting is
      // transaction-local and the complete copy is verified before commit is
      // promoted through placement.
      await target.query("SET LOCAL session_replication_role = replica");
      await target.query("SET CONSTRAINTS ALL DEFERRED");
      await target.query(
        "SELECT set_config('skillplane.workspace_migration_cleanup', $1, true)",
        [context.namespace],
      );
      for (const table of [...dynamic, ...regionalTables].toReversed()) {
        const column = dynamic.includes(table) ? "__ns" : "workspace_id";
        await target.query(
          `DELETE FROM ${identifier(table)} WHERE ${identifier(column)} = $1`,
          [context.namespace],
        );
      }
      for (const table of [...regionalTables, ...dynamic]) {
        const column = dynamic.includes(table) ? "__ns" : "workspace_id";
        await insertRows(
          target,
          table,
          await rowsForWorkspace(source, table, context.namespace, column),
        );
      }
      await target.query("COMMIT");
    } catch (error) {
      await target.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      target.release();
    }
  }

  private async bundleKeys(workspaceId: string): Promise<string[]> {
    const source = this.quiescedSource ?? this.source;
    const result = await source.query<{ r2_object_key: string }>(
      `SELECT DISTINCT r2_object_key
         FROM skill_versions
        WHERE workspace_id = $1
        ORDER BY r2_object_key`,
      [workspaceId],
    );
    return result.rows.map((row) => row.r2_object_key);
  }

  async copyBundles(context: DatafnNamespaceMigrationContext): Promise<void> {
    for (const key of await this.bundleKeys(context.namespace)) {
      await this.targetObjects.put(key, await this.sourceObjects.read(key));
    }
  }

  async verifyDatabase(
    context: DatafnNamespaceMigrationContext,
  ): Promise<readonly MigrationCheck[]> {
    const dynamic = await dynamicNamespaceTables(this.source);
    const checks: MigrationCheck[] = [];
    for (const table of [...regionalTables, ...dynamic]) {
      const column = dynamic.includes(table) ? "__ns" : "workspace_id";
      const [source, target] = await Promise.all([
        checksum(this.quiescedSource ?? this.source, table, context.namespace, column),
        checksum(this.target, table, context.namespace, column),
      ]);
      checks.push({
        name: `database:${table}`,
        source: `${source.count}:${source.checksum}`,
        target: `${target.count}:${target.checksum}`,
        matched: source.count === target.count && source.checksum === target.checksum,
      });
    }
    return checks;
  }

  async verifyBundles(
    context: DatafnNamespaceMigrationContext,
  ): Promise<readonly MigrationCheck[]> {
    const checks: MigrationCheck[] = [];
    for (const key of await this.bundleKeys(context.namespace)) {
      const [source, target] = await Promise.all([
        this.sourceObjects.read(key),
        this.targetObjects.read(key),
      ]);
      const [sourceDigest, targetDigest] = await Promise.all([
        digest(source),
        digest(target),
      ]);
      checks.push({
        name: `bundle:${key}`,
        source: sourceDigest,
        target: targetDigest,
        matched: sourceDigest === targetDigest,
      });
    }
    return checks;
  }

  async rebuildGlobalResourceDirectory(
    context: DatafnNamespaceMigrationContext,
  ): Promise<void> {
    for (const [resourceType, table] of [
      ["skill", "skills"],
      ["skill_version", "skill_versions"],
      ["context", "skill_contexts"],
      ["context_note", "context_notes"],
    ] as const) {
      const resources = await this.target.query<{ id: string }>(
        `SELECT id FROM ${identifier(table)} WHERE workspace_id = $1 ORDER BY id`,
        [context.namespace],
      );
      for (const resource of resources.rows) {
        await this.control.query(
          `INSERT INTO resource_routing_directory
             (resource_type, resource_id, workspace_id, state, updated_at)
           VALUES ($1, $2, $3, 'active', now())
           ON CONFLICT (resource_type, resource_id)
           DO UPDATE SET workspace_id = EXCLUDED.workspace_id,
                         state = 'active', updated_at = now()`,
          [resourceType, resource.id, context.namespace],
        );
      }
    }
  }

  async warmTarget(context: DatafnNamespaceMigrationContext): Promise<void> {
    await this.target.query("SELECT count(*) FROM skills WHERE workspace_id = $1", [
      context.namespace,
    ]);
  }

  private async releaseSource(): Promise<void> {
    const source = this.quiescedSource;
    this.quiescedSource = null;
    if (!source) return;
    await source.query("COMMIT").catch(async () => {
      await source.query("ROLLBACK").catch(() => undefined);
    });
    source.release();
  }

  async resumeTarget(context: DatafnNamespaceMigrationContext): Promise<void> {
    void context;
    await this.releaseSource();
  }

  async rollbackSource(
    context: DatafnNamespaceMigrationContext & { readonly cause: unknown },
  ): Promise<void> {
    try {
      const dynamic = await dynamicNamespaceTables(this.target);
      const client = await this.target.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        await client.query(
          "SELECT set_config('skillplane.workspace_migration_cleanup', $1, true)",
          [context.namespace],
        );
        for (const table of [...dynamic, ...regionalTables].toReversed()) {
          const column = dynamic.includes(table) ? "__ns" : "workspace_id";
          await client.query(
            `DELETE FROM ${identifier(table)} WHERE ${identifier(column)} = $1`,
            [context.namespace],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      for (const key of await this.bundleKeys(context.namespace)) {
        await this.targetObjects.delete(key).catch(() => undefined);
      }
    } finally {
      await this.releaseSource();
    }
  }
}
