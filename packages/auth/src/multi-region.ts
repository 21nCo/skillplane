import type {
  AuthFnIdentityPlacement,
  AuthFnIdentityPlacementDirectoryAdapter,
  AuthFnIdentityPlacementState,
  MultiRegionPluginRuntimeConfig,
} from "@authfn/multi-region";
import type { Pool } from "pg";
import { AUTH_COOKIE_CONFIG } from "./session.js";

interface PlacementRow {
  readonly identity_key: string;
  readonly region_id: string;
  readonly epoch: string | number;
  readonly state: AuthFnIdentityPlacementState;
  readonly moving_to_region_id: string | null;
  readonly previous_region_id: string | null;
  readonly updated_at: Date;
}

function placement(row: PlacementRow): AuthFnIdentityPlacement {
  return {
    identityKey: row.identity_key,
    regionId: row.region_id,
    epoch: Number(row.epoch),
    state: row.state,
    ...(row.moving_to_region_id ? { movingToRegionId: row.moving_to_region_id } : {}),
    ...(row.previous_region_id ? { previousRegionId: row.previous_region_id } : {}),
    updatedAt: row.updated_at,
  };
}

const PLACEMENT_COLUMNS = `identity_key, region_id, epoch, state,
  moving_to_region_id, previous_region_id, updated_at`;

export function createPostgresAuthFnPlacementDirectory(
  pool: Pool,
): AuthFnIdentityPlacementDirectoryAdapter {
  return {
    async get(identityKey) {
      const result = await pool.query<PlacementRow>(
        `SELECT ${PLACEMENT_COLUMNS}
           FROM authfn_identity_placements
          WHERE identity_key = $1
          LIMIT 1`,
        [identityKey],
      );
      return result.rows[0] ? placement(result.rows[0]) : null;
    },
    async putIfAbsent(value) {
      const result = await pool.query<PlacementRow>(
        `INSERT INTO authfn_identity_placements
           (identity_key, region_id, epoch, state, moving_to_region_id,
            previous_region_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (identity_key) DO NOTHING
         RETURNING ${PLACEMENT_COLUMNS}`,
        [
          value.identityKey,
          value.regionId,
          value.epoch,
          value.state,
          value.movingToRegionId ?? null,
          value.previousRegionId ?? null,
          value.updatedAt,
        ],
      );
      if (result.rows[0]) return { inserted: true };
      const existing = await this.get(value.identityKey);
      return existing ? { inserted: false, existing } : { inserted: false };
    },
    async compareAndSet(input) {
      const value = input.placement;
      if (value.identityKey !== input.identityKey) {
        throw new Error("AUTHFN_PLACEMENT_IDENTITY_MISMATCH");
      }
      const result = await pool.query<PlacementRow>(
        `UPDATE authfn_identity_placements
            SET region_id = $4, epoch = $5, state = $6,
                moving_to_region_id = $7, previous_region_id = $8,
                updated_at = $9
          WHERE identity_key = $1 AND epoch = $2 AND state = $3
          RETURNING ${PLACEMENT_COLUMNS}`,
        [
          input.identityKey,
          input.expectedEpoch,
          input.expectedState,
          value.regionId,
          value.epoch,
          value.state,
          value.movingToRegionId ?? null,
          value.previousRegionId ?? null,
          value.updatedAt,
        ],
      );
      if (result.rows[0]) return { updated: true };
      const existing = await this.get(input.identityKey);
      return existing ? { updated: false, existing } : { updated: false };
    },
  };
}

export function createSkillplaneAuthFnMultiRegionConfig(input: {
  readonly issuer: string;
  readonly resource: string;
}): MultiRegionPluginRuntimeConfig {
  return {
    regions: [
      {
        regionId: "global",
        authority: input.issuer,
        issuer: input.issuer,
        baseUrl: input.issuer,
      },
    ],
    defaultRegionId: "global",
    routing: {
      // AuthFn state is globally owned and terminates in the public app Worker.
      // Canonical gateway mode is reserved for a future topology where that
      // edge dispatches to a distinct private AuthFn control Worker.
      mode: "direct",
      publicAuthority: input.issuer,
      canonicalCookie: AUTH_COOKIE_CONFIG,
      canonicalOAuth: { resource: input.resource },
    },
  };
}
