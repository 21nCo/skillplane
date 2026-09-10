import type { RuntimeConfig } from "@skillplane/config";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import type { Adapter } from "@superfunctions/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import {
  globalControlSchema,
  regionalWorkspaceSchema,
  schema,
} from "./schema/index.js";

const adapterSchema = {
  ...schema,
  users: schema.authfn_users,
  sessions: schema.authfn_sessions,
  otp_challenges: schema.authfn_otp_challenges,
  api_keys: schema.authfn_api_keys,
  region_profiles: schema.authfn_region_profiles,
};

const controlAdapterSchema = {
  ...globalControlSchema,
  users: globalControlSchema.authfn_users,
  sessions: globalControlSchema.authfn_sessions,
  otp_challenges: globalControlSchema.authfn_otp_challenges,
  api_keys: globalControlSchema.authfn_api_keys,
  region_profiles: globalControlSchema.authfn_region_profiles,
};

const regionalAdapterSchema = { ...regionalWorkspaceSchema };

export type DatabaseRole = "combined" | "control" | "regional";

export type SkillplaneDatabase = NodePgDatabase<typeof adapterSchema>;

export interface DatabaseClient {
  readonly role: DatabaseRole;
  readonly pool: Pool;
  readonly db: SkillplaneDatabase;
  readonly adapter: Adapter;
  close(): Promise<void>;
}

export interface DatabaseClientOptions {
  readonly connectionString: string;
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly ssl?: PoolConfig["ssl"];
  readonly role?: DatabaseRole;
}

export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const role = options.role ?? "combined";
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? "skillplane",
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    ssl: options.ssl,
  });
  const selectedSchema =
    role === "control"
      ? controlAdapterSchema
      : role === "regional"
        ? regionalAdapterSchema
        : adapterSchema;
  // Consumers use the pool for domain SQL and the adapter for AuthFn/DataFn.
  // The declared superset type preserves compatibility while the runtime
  // adapter is deliberately restricted to its database owner's tables.
  const db = drizzle(pool, { schema: selectedSchema }) as SkillplaneDatabase;
  const adapter = drizzleAdapter({
    db,
    dialect: "postgres",
  });
  return {
    role,
    pool,
    db,
    adapter,
    close: () => pool.end(),
  };
}

export function createRuntimeDatabaseClient(config: RuntimeConfig): DatabaseClient {
  return createDatabaseClient({
    connectionString: config.database.connectionString,
    applicationName: `skillplane-${config.environment}`,
    maxConnections: config.database.source === "hyperdrive" ? 5 : 10,
  });
}

export function createControlDatabaseClient(
  options: Omit<DatabaseClientOptions, "role">,
): DatabaseClient {
  return createDatabaseClient({ ...options, role: "control" });
}

export function createRegionalDatabaseClient(
  options: Omit<DatabaseClientOptions, "role">,
): DatabaseClient {
  return createDatabaseClient({ ...options, role: "regional" });
}
