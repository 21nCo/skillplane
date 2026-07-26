import type { RuntimeConfig } from "@skillplane/config";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import type { Adapter } from "@superfunctions/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { schema } from "./schema/index.js";

const adapterSchema = {
  ...schema,
  users: schema.authfn_users,
  sessions: schema.authfn_sessions,
  otp_challenges: schema.authfn_otp_challenges,
  api_keys: schema.authfn_api_keys,
};

export type SkillplaneDatabase = NodePgDatabase<typeof adapterSchema>;

export interface DatabaseClient {
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
}

export function createDatabaseClient(options: DatabaseClientOptions): DatabaseClient {
  const pool = new Pool({
    connectionString: options.connectionString,
    application_name: options.applicationName ?? "skillplane",
    max: options.maxConnections ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    ssl: options.ssl,
  });
  const db = drizzle(pool, { schema: adapterSchema });
  const adapter = drizzleAdapter({
    db,
    dialect: "postgres",
  });
  return {
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
