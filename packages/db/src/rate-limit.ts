import { createHash } from "node:crypto";
import type { Pool } from "pg";

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export async function consumeRateLimit(
  pool: Pool,
  key: string,
  limit: number,
  windowSeconds: number,
  now = new Date(),
): Promise<RateLimitDecision> {
  if (!Number.isInteger(limit) || limit < 1 || windowSeconds < 1) {
    throw new Error("Rate-limit configuration must use positive integers");
  }
  const epochSeconds = Math.floor(now.getTime() / 1000);
  const startedSeconds = Math.floor(epochSeconds / windowSeconds) * windowSeconds;
  const windowStartedAt = new Date(startedSeconds * 1000);
  const expiresAt = new Date((startedSeconds + windowSeconds * 2) * 1000);
  const bucketHash = createHash("sha256").update(key).digest("hex");
  const result = await pool.query<{ request_count: number }>(
    `INSERT INTO api_rate_limits
       (bucket_hash, window_started_at, request_count, expires_at)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (bucket_hash, window_started_at)
     DO UPDATE SET request_count = api_rate_limits.request_count + 1
     RETURNING request_count`,
    [bucketHash, windowStartedAt, expiresAt],
  );
  const count = result.rows[0]?.request_count ?? limit + 1;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, startedSeconds + windowSeconds - epochSeconds),
  };
}
