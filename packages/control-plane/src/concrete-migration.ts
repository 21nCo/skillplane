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
  "regional_projection_sequences",
  "regional_projection_outbox",
] as const;

type NamespaceColumn = "workspace_id" | "__ns" | "namespace";

interface DynamicNamespaceTable {
  readonly tableName: string;
  readonly namespaceColumn: "__ns" | "namespace";
}

interface DynamicTableColumn extends Record<string, unknown> {
  readonly column_name: string;
  readonly data_type: string;
  readonly not_null: boolean;
  readonly default_expression: string | null;
  readonly identity_kind: "" | "a" | "d";
  readonly generated_kind: "" | "s";
  readonly sequence_name: string | null;
}

interface DynamicTableConstraint extends Record<string, unknown> {
  readonly constraint_name: string;
  readonly constraint_type: "c" | "f" | "p" | "u" | "x";
  readonly definition: string;
}

interface DynamicTableIndex extends Record<string, unknown> {
  readonly index_name: string;
  readonly definition: string;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error("WORKSPACE_MIGRATION_IDENTIFIER_INVALID");
  }
  return `"${value}"`;
}

function sequenceIdentifier(value: string): string {
  const match = /^public\.([a-z_][a-z0-9_]{0,62})$/u.exec(value);
  if (!match?.[1]) {
    throw new Error("WORKSPACE_MIGRATION_SEQUENCE_IDENTIFIER_INVALID");
  }
  return `${identifier("public")}.${identifier(match[1])}`;
}

async function dynamicNamespaceTables(
  pool: MigrationSqlPool,
): Promise<DynamicNamespaceTable[]> {
  const result = await pool.query<{
    table_name: string;
    namespace_column: "__ns" | "namespace";
  }>(
    `SELECT table_name,
            CASE WHEN bool_or(column_name = '__ns') THEN '__ns'
                 ELSE 'namespace' END AS namespace_column
       FROM information_schema.columns
      WHERE table_schema = 'public'
      GROUP BY table_name
     HAVING bool_or(column_name = '__ns')
         OR (left(table_name, 9) = '__datafn_' AND
             bool_or(column_name = 'namespace'))
      ORDER BY table_name`,
  );
  return result.rows
    .filter(
      (row) =>
        !regionalTables.includes(row.table_name as (typeof regionalTables)[number]),
    )
    .map((row) => ({
      tableName: row.table_name,
      namespaceColumn: row.namespace_column,
    }));
}

async function dynamicTableColumns(
  database: MigrationSqlQueryable,
  tableName: string,
): Promise<readonly DynamicTableColumn[]> {
  return (
    await database.query<DynamicTableColumn>(
      `SELECT attribute.attname AS column_name,
              pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                AS data_type,
              attribute.attnotnull AS not_null,
              pg_get_expr(default_value.adbin, default_value.adrelid)
                AS default_expression,
              attribute.attidentity AS identity_kind,
              attribute.attgenerated AS generated_kind,
              pg_get_serial_sequence(
                pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
                attribute.attname
              ) AS sequence_name
         FROM pg_catalog.pg_attribute attribute
         JOIN pg_catalog.pg_class relation
           ON relation.oid = attribute.attrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
         LEFT JOIN pg_catalog.pg_attrdef default_value
           ON default_value.adrelid = attribute.attrelid
          AND default_value.adnum = attribute.attnum
        WHERE namespace.nspname = 'public'
          AND relation.relname = $1
          AND relation.relkind IN ('r', 'p')
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
        ORDER BY attribute.attnum`,
      [tableName],
    )
  ).rows;
}

function columnDefinition(column: DynamicTableColumn): string {
  let generated = "";
  if (column.generated_kind === "s") {
    if (!column.default_expression) {
      throw new Error("WORKSPACE_MIGRATION_DYNAMIC_COLUMN_GENERATION_INVALID");
    }
    generated = ` GENERATED ALWAYS AS (${column.default_expression}) STORED`;
  } else if (column.identity_kind === "a") {
    generated = " GENERATED ALWAYS AS IDENTITY";
  } else if (column.identity_kind === "d") {
    generated = " GENERATED BY DEFAULT AS IDENTITY";
  } else if (column.sequence_name) {
    generated = ` DEFAULT nextval('${sequenceIdentifier(column.sequence_name)}'::regclass)`;
  } else if (column.default_expression) {
    generated = ` DEFAULT ${column.default_expression}`;
  }
  return `${identifier(column.column_name)} ${column.data_type}${generated}${
    column.not_null ? " NOT NULL" : ""
  }`;
}

async function dynamicTableConstraints(
  database: MigrationSqlQueryable,
  tableName: string,
): Promise<readonly DynamicTableConstraint[]> {
  return (
    await database.query<DynamicTableConstraint>(
      `SELECT constraint_definition.conname AS constraint_name,
              constraint_definition.contype AS constraint_type,
              pg_get_constraintdef(constraint_definition.oid, true) AS definition
         FROM pg_catalog.pg_constraint constraint_definition
         JOIN pg_catalog.pg_class relation
           ON relation.oid = constraint_definition.conrelid
         JOIN pg_catalog.pg_namespace namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = $1
        ORDER BY constraint_definition.conname`,
      [tableName],
    )
  ).rows;
}

async function dynamicTableIndexes(
  database: MigrationSqlQueryable,
  tableName: string,
): Promise<readonly DynamicTableIndex[]> {
  return (
    await database.query<DynamicTableIndex>(
      `SELECT indexname AS index_name, indexdef AS definition
         FROM pg_catalog.pg_indexes
        WHERE schemaname = 'public' AND tablename = $1
        ORDER BY indexname`,
      [tableName],
    )
  ).rows;
}

async function cloneDynamicTableColumns(
  source: MigrationSqlQueryable,
  target: MigrationSqlQueryable,
  tableName: string,
): Promise<void> {
  const columns = await dynamicTableColumns(source, tableName);
  if (columns.length === 0) {
    throw new Error(`WORKSPACE_MIGRATION_DYNAMIC_TABLE_SCHEMA_MISSING:${tableName}`);
  }
  for (const column of columns) {
    if (column.sequence_name && column.identity_kind === "") {
      await target.query(
        `CREATE SEQUENCE IF NOT EXISTS ${sequenceIdentifier(column.sequence_name)}`,
      );
    }
  }
  await target.query(
    `CREATE TABLE IF NOT EXISTS ${identifier(tableName)}
       (${columns.map(columnDefinition).join(", ")})`,
  );
  for (const column of columns) {
    if (column.sequence_name && column.identity_kind === "") {
      await target.query(
        `ALTER SEQUENCE ${sequenceIdentifier(column.sequence_name)}
           OWNED BY ${identifier(tableName)}.${identifier(column.column_name)}`,
      );
    }
  }
  const targetColumns = await dynamicTableColumns(target, tableName);
  if (JSON.stringify(targetColumns) !== JSON.stringify(columns)) {
    throw new Error(`WORKSPACE_MIGRATION_DYNAMIC_TABLE_SCHEMA_MISMATCH:${tableName}`);
  }
}

async function cloneDynamicTableConstraints(
  source: MigrationSqlQueryable,
  target: MigrationSqlQueryable,
  tableName: string,
  constraintType: "foreign" | "non-foreign",
): Promise<void> {
  const constraints = (await dynamicTableConstraints(source, tableName)).filter(
    (constraint) =>
      constraintType === "foreign"
        ? constraint.constraint_type === "f"
        : constraint.constraint_type !== "f",
  );
  const existingConstraintNames = new Set(
    (await dynamicTableConstraints(target, tableName)).map(
      (constraint) => constraint.constraint_name,
    ),
  );
  for (const constraint of constraints) {
    if (!existingConstraintNames.has(constraint.constraint_name)) {
      await target.query(
        `ALTER TABLE ${identifier(tableName)}
           ADD CONSTRAINT ${identifier(constraint.constraint_name)}
           ${constraint.definition}`,
      );
    }
  }
}

async function cloneDynamicTableIndexes(
  source: MigrationSqlQueryable,
  target: MigrationSqlQueryable,
  tableName: string,
): Promise<void> {
  const indexes = await dynamicTableIndexes(source, tableName);
  const existingIndexNames = new Set(
    (await dynamicTableIndexes(target, tableName)).map((index) => index.index_name),
  );
  for (const index of indexes) {
    if (!existingIndexNames.has(index.index_name)) {
      await target.query(index.definition);
    }
  }
}

async function assertDynamicTableSchema(
  source: MigrationSqlQueryable,
  target: MigrationSqlQueryable,
  tableName: string,
): Promise<void> {
  if (
    JSON.stringify(await dynamicTableConstraints(target, tableName)) !==
      JSON.stringify(await dynamicTableConstraints(source, tableName)) ||
    JSON.stringify(await dynamicTableIndexes(target, tableName)) !==
      JSON.stringify(await dynamicTableIndexes(source, tableName))
  ) {
    throw new Error(`WORKSPACE_MIGRATION_DYNAMIC_TABLE_SCHEMA_MISMATCH:${tableName}`);
  }
}

async function installDynamicMigrationFences(
  pool: MigrationSqlQueryable,
  tables: readonly DynamicNamespaceTable[],
): Promise<void> {
  for (const { tableName } of tables) {
    await pool.query(
      `CREATE OR REPLACE TRIGGER skillplane_fence_workspace_migration_write
       BEFORE INSERT OR UPDATE OR DELETE ON ${identifier(tableName)}
       FOR EACH ROW EXECUTE FUNCTION skillplane_fence_workspace_migration_write()`,
    );
  }
}

function migrationTables(dynamic: readonly DynamicNamespaceTable[]): readonly {
  readonly tableName: string;
  readonly namespaceColumn: NamespaceColumn;
}[] {
  return [
    ...regionalTables.map((tableName) => ({
      tableName,
      namespaceColumn: "workspace_id" as const,
    })),
    ...dynamic,
  ];
}

async function rowsForWorkspace(
  client: MigrationSqlClient,
  table: string,
  workspaceId: string,
  namespaceColumn: NamespaceColumn,
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
    is_identity: "YES" | "NO";
    sequence_name: string | null;
  }>(
    `SELECT column_name, is_identity,
            pg_get_serial_sequence(
              format('%I.%I', table_schema, table_name),
              column_name
            ) AS sequence_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table],
  );
  const columns = writable.rows.map((column) => column.column_name);
  const overriding = writable.rows.some((column) => column.is_identity === "YES")
    ? " OVERRIDING SYSTEM VALUE"
    : "";
  for (const row of rows) {
    if (columns.length === 0) continue;
    await client.query(
      `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(", ")})${overriding}
       SELECT ${columns.map(identifier).join(", ")}
         FROM jsonb_populate_record(NULL::${identifier(table)}, $1::jsonb)`,
      [row],
    );
  }
  for (const column of writable.rows) {
    if (!column.sequence_name) continue;
    await client.query(
      `SELECT setval(
         $1::regclass,
         COALESCE((SELECT max(${identifier(column.column_name)})::bigint
                     FROM ${identifier(table)}), 1),
         EXISTS(SELECT 1 FROM ${identifier(table)})
       )`,
      [column.sequence_name],
    );
  }
}

async function checksum(
  pool: MigrationSqlQueryable,
  table: string,
  workspaceId: string,
  namespaceColumn: NamespaceColumn,
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
  private sourceQuiesced = false;

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
              WHERE namespace = $1`,
            [workspaceId],
          )
        ).rows[0]?.count
      : "0";
    return Number(projection.rows[0]?.count ?? "0") + Number(datafnCount ?? "0");
  }

  async prepareSource(workspaceId: string): Promise<void> {
    await this.waitForOutboxes(workspaceId);
  }

  private async waitForOutboxes(workspaceId: string): Promise<void> {
    const deadline = Date.now() + 75_000;
    while ((await this.pendingOutboxes(workspaceId)) > 0) {
      if (Date.now() >= deadline) {
        throw new Error("WORKSPACE_MIGRATION_OUTBOX_NOT_DRAINED");
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  async quiesceSource(context: DatafnNamespaceMigrationContext): Promise<void> {
    if (this.sourceQuiesced) return;
    const dynamic = await dynamicNamespaceTables(this.source);
    await installDynamicMigrationFences(this.source, dynamic);
    await this.source.query(
      `INSERT INTO regional_workspace_migration_fences
         (workspace_id, source_epoch, fenced_at)
       VALUES ($1, $2, now())
       ON CONFLICT (workspace_id)
       DO UPDATE SET source_epoch = EXCLUDED.source_epoch, fenced_at = now()`,
      [context.namespace, context.sourceEpoch],
    );
    // The trigger holds a shared lock on this workspace's durable fence row
    // for every accepted DML transaction. Raising the row above waits for all
    // pre-fence writes in this namespace without blocking unrelated tenants.
    this.sourceQuiesced = true;
  }

  async drainOutboxes(context: DatafnNamespaceMigrationContext): Promise<void> {
    // This is the authoritative drain: quiesceSource has installed the
    // database fence and drained pre-fence DML, so no accepted workspace write
    // can enqueue another event. Drain-table mutations remain permitted so
    // consumers can settle a write that committed in the narrow window between
    // the optimistic pre-drain and the placement CAS. Retain the source
    // snapshot only after those acknowledgements converge.
    await this.waitForOutboxes(context.namespace);
    if (this.quiescedSource) return;
    if (!this.sourceQuiesced) {
      throw new Error("WORKSPACE_MIGRATION_SOURCE_NOT_QUIESCED");
    }
    const client = await this.source.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await client.query("SELECT count(*) FROM skills WHERE workspace_id = $1", [
        context.namespace,
      ]);
      this.quiescedSource = client;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      throw error;
    }
  }

  async copyDatabase(context: DatafnNamespaceMigrationContext): Promise<void> {
    const source = this.quiescedSource;
    if (!source) throw new Error("WORKSPACE_MIGRATION_SOURCE_NOT_QUIESCED");
    const target = await this.target.connect();
    const dynamic = await dynamicNamespaceTables(this.source);
    const tables = migrationTables(dynamic);
    try {
      await target.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      for (const table of dynamic) {
        await cloneDynamicTableColumns(source, target, table.tableName);
      }
      // Create every table before adding foreign keys because one dynamic
      // DataFn table may reference another table discovered later.
      for (const table of dynamic) {
        await cloneDynamicTableConstraints(
          source,
          target,
          table.tableName,
          "non-foreign",
        );
      }
      for (const table of dynamic) {
        await cloneDynamicTableConstraints(source, target, table.tableName, "foreign");
      }
      for (const table of dynamic) {
        await cloneDynamicTableIndexes(source, target, table.tableName);
        await assertDynamicTableSchema(source, target, table.tableName);
      }
      await installDynamicMigrationFences(target, dynamic);
      // Preserve the source row image exactly. Application triggers derive
      // search fields and timestamps as related rows arrive, which would make
      // a logically identical copy fail the stable checksum. This setting is
      // transaction-local and the complete copy is verified before commit is
      // promoted through placement.
      await target.query("SET LOCAL session_replication_role = replica");
      await target.query("SET CONSTRAINTS ALL DEFERRED");
      for (const table of tables.toReversed()) {
        await target.query(
          `DELETE FROM ${identifier(table.tableName)} WHERE ${identifier(table.namespaceColumn)} = $1`,
          [context.namespace],
        );
      }
      for (const table of tables) {
        await insertRows(
          target,
          table.tableName,
          await rowsForWorkspace(
            source,
            table.tableName,
            context.namespace,
            table.namespaceColumn,
          ),
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
    for (const table of migrationTables(dynamic)) {
      const [source, target] = await Promise.all([
        checksum(
          this.quiescedSource ?? this.source,
          table.tableName,
          context.namespace,
          table.namespaceColumn,
        ),
        checksum(
          this.target,
          table.tableName,
          context.namespace,
          table.namespaceColumn,
        ),
      ]);
      checks.push({
        name: `database:${table.tableName}`,
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
    await this.rebuildGlobalResourceDirectoryFrom(this.target, context);
  }

  private async rebuildGlobalResourceDirectoryFrom(
    database: MigrationSqlQueryable,
    context: DatafnNamespaceMigrationContext,
  ): Promise<void> {
    for (const [resourceType, table] of [
      ["skill", "skills"],
      ["skill_version", "skill_versions"],
      ["context", "skill_contexts"],
      ["context_note", "context_notes"],
    ] as const) {
      const resources = await database.query<{ id: string }>(
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
    this.sourceQuiesced = false;
    if (source) {
      await source.query("COMMIT").catch(async () => {
        await source.query("ROLLBACK").catch(() => undefined);
      });
      source.release();
    }
  }

  async resumeTarget(context: DatafnNamespaceMigrationContext): Promise<void> {
    // A cell can become the target after having previously been the source.
    // Open a new active generation before the placement becomes active again.
    // A recovery lease may advance the final placement epoch further. The
    // moving epoch is therefore a lower bound for this ownership generation.
    await this.target.query(
      `INSERT INTO regional_workspace_migration_fences
         (workspace_id, source_epoch, active_epoch, fenced_at)
       VALUES ($1, 0, $2, now())
       ON CONFLICT (workspace_id)
       DO UPDATE SET source_epoch = 0,
                     active_epoch = GREATEST(
                       regional_workspace_migration_fences.active_epoch,
                       EXCLUDED.active_epoch
                     ),
                     fenced_at = now()`,
      [context.namespace, context.movingEpoch + 1],
    );
    // Keep the source-cell fence as a tombstone. It rejects even an old
    // repeatable-read transaction which reaches DML after activation.
    await this.releaseSource();
  }

  async rollbackSource(
    context: DatafnNamespaceMigrationContext & { readonly cause: unknown },
  ): Promise<void> {
    try {
      const dynamic = await dynamicNamespaceTables(this.target);
      const tables = migrationTables(dynamic);
      const client = await this.target.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL session_replication_role = replica");
        await client.query("SET CONSTRAINTS ALL DEFERRED");
        for (const table of tables.toReversed()) {
          await client.query(
            `DELETE FROM ${identifier(table.tableName)} WHERE ${identifier(table.namespaceColumn)} = $1`,
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
        await this.targetObjects.delete(key);
      }
      await this.rebuildGlobalResourceDirectoryFrom(this.source, context);
      await this.releaseSource();
      await this.source.query(
        `UPDATE regional_workspace_migration_fences
            SET source_epoch = 0,
                active_epoch = GREATEST(active_epoch, $2),
                fenced_at = now()
          WHERE workspace_id = $1`,
        [context.namespace, context.movingEpoch + 1],
      );
    } catch (error) {
      // Release the retained snapshot connection, but leave the durable source
      // fence raised so recovery cannot resume writes after partial cleanup.
      await this.releaseSource();
      throw error;
    }
  }
}
