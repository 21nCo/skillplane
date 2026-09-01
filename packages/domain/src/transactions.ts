import type { Pool, PoolClient } from "pg";

export type DomainTransactionIsolation =
  "read committed" | "repeatable read" | "serializable";

function retryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "40001" || error.code === "40P01")
  );
}

function retryDelay(attempt: number): Promise<void> {
  const exponentialMs = Math.min(100, 5 * 2 ** attempt);
  const jitterMs = Math.floor(Math.random() * 6);
  return new Promise((resolve) => setTimeout(resolve, exponentialMs + jitterMs));
}

export async function withDomainTransaction<T>(
  pool: Pool,
  requestId: string,
  operation: (context: { readonly client: PoolClient }) => Promise<T>,
  options: {
    readonly isolation?: DomainTransactionIsolation;
    readonly maxRetries?: number;
    readonly fencingEpoch?: number | undefined;
  } = {},
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
      if (options.fencingEpoch !== undefined) {
        await client.query(
          "SELECT set_config('skillplane.workspace_routing_epoch', $1, true)",
          [String(options.fencingEpoch)],
        );
      }
      const result = await operation({ client });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (!retryable(error) || attempt >= maxRetries) throw error;
    } finally {
      client.release();
    }
    await retryDelay(attempt);
  }
}
