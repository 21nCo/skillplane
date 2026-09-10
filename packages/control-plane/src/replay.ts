import type { DatafnRoutingReplayStore } from "@datafn/server";
import type { PlacementSqlClient } from "./placement.js";

/** Atomic, cross-instance replay protection for signed gateway assertions. */
export function createPostgresRoutingReplayStore(
  sql: PlacementSqlClient,
): DatafnRoutingReplayStore {
  return {
    async claim(nonce, expiresAt) {
      const expiry = new Date(expiresAt);
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        return false;
      }
      const result = await sql.query<{ nonce: string }>(
        `WITH expired AS (
           DELETE FROM workspace_routing_nonces
            WHERE expires_at <= now()
         )
         INSERT INTO workspace_routing_nonces (nonce, expires_at)
         VALUES ($1, $2)
         ON CONFLICT (nonce) DO NOTHING
         RETURNING nonce`,
        [nonce, expiry],
      );
      return result.rows.length === 1;
    },
  };
}
