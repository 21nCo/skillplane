import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export type TransactionIsolation =
  "read committed" | "repeatable read" | "serializable";

export interface TransactionContext {
  readonly client: PoolClient;
  readonly requestId: string;
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface TransactionOptions {
  readonly isolation?: TransactionIsolation;
  readonly maxRetries?: number;
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "40001" || error.code === "40P01";
}

function retryDelay(attempt: number): Promise<void> {
  const exponentialMs = Math.min(100, 5 * 2 ** attempt);
  const jitterMs = Math.floor(Math.random() * 6);
  return new Promise((resolve) => setTimeout(resolve, exponentialMs + jitterMs));
}

export async function withTransaction<T>(
  pool: Pool,
  requestId: string,
  operation: (context: TransactionContext) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const isolation = options.isolation ?? "serializable";
  const maxRetries = options.maxRetries ?? 5;
  for (let attempt = 0; ; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation.toUpperCase()}`);
      await client.query("SELECT set_config('application_name', $1, true)", [
        `skillplane request=${requestId}`,
      ]);
      const context: TransactionContext = {
        client,
        requestId,
        query<Row extends QueryResultRow = QueryResultRow>(
          text: string,
          values?: readonly unknown[],
        ) {
          return client.query<Row>(text, values ? [...values] : []);
        },
      };
      const result = await operation(context);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!isRetryable(error) || attempt >= maxRetries) {
        throw error;
      }
    } finally {
      client.release();
    }
    await retryDelay(attempt);
  }
}
