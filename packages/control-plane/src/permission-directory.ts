import type {
  IndexedDirectoryRecord,
  IndexedDirectoryStoreAdapter,
} from "@superfunctions/db";
import type { PlacementSqlClient } from "./placement.js";

interface DirectoryRow extends Record<string, unknown> {
  readonly key: string;
  readonly value: string;
  readonly indexes: Record<string, string | readonly string[] | null> | null;
  readonly expires_at: Date | string | null;
}

function record(row: DirectoryRow): IndexedDirectoryRecord {
  const ttlSeconds = row.expires_at
    ? Math.max(0, Math.ceil((new Date(row.expires_at).getTime() - Date.now()) / 1_000))
    : undefined;
  return {
    key: row.key,
    value: row.value,
    ...(row.indexes ? { indexes: row.indexes } : {}),
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };
}

function expiry(ttlSeconds: number | undefined): Date | null {
  if (ttlSeconds === undefined) return null;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("PERMISSION_DIRECTORY_TTL_INVALID");
  }
  return new Date(Date.now() + ttlSeconds * 1_000);
}

/** Durable global projection for DataFn permission-directory plugins. */
export function createPostgresPermissionDirectory(
  sql: PlacementSqlClient,
): IndexedDirectoryStoreAdapter {
  const get = async (key: string): Promise<IndexedDirectoryRecord | null> => {
    const result = await sql.query<DirectoryRow>(
      `SELECT key, value, indexes, expires_at
         FROM permission_directory_records
        WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [key],
    );
    const row = result.rows[0];
    return row ? record(row) : null;
  };
  return {
    get,
    async put(input) {
      await sql.query(
        `INSERT INTO permission_directory_records
           (key, value, indexes, expires_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (key)
         DO UPDATE SET value = EXCLUDED.value, indexes = EXCLUDED.indexes,
                       expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [
          input.key,
          input.value,
          JSON.stringify(input.indexes ?? {}),
          expiry(input.ttlSeconds),
        ],
      );
    },
    async putIfAbsent(input) {
      const result = await sql.query<DirectoryRow>(
        `INSERT INTO permission_directory_records
           (key, value, indexes, expires_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (key) DO NOTHING
         RETURNING key, value, indexes, expires_at`,
        [
          input.key,
          input.value,
          JSON.stringify(input.indexes ?? {}),
          expiry(input.ttlSeconds),
        ],
      );
      if (result.rows[0]) return { inserted: true };
      const existing = await get(input.key);
      return existing ? { inserted: false, existing } : { inserted: false };
    },
    async update(input) {
      const result = await sql.query<DirectoryRow>(
        `UPDATE permission_directory_records
            SET value = $2, indexes = $3::jsonb, expires_at = $4,
                updated_at = now()
          WHERE key = $1
          RETURNING key, value, indexes, expires_at`,
        [
          input.key,
          input.value,
          JSON.stringify(input.indexes ?? {}),
          expiry(input.ttlSeconds),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("PERMISSION_DIRECTORY_RECORD_NOT_FOUND");
      return record(row);
    },
    async delete(key) {
      await sql.query("DELETE FROM permission_directory_records WHERE key = $1", [key]);
    },
    async query(input) {
      const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
      const after = input.cursor ? decodeURIComponent(input.cursor) : "";
      const result = await sql.query<DirectoryRow>(
        `SELECT key, value, indexes, expires_at
           FROM permission_directory_records
          WHERE key > $3
            AND (expires_at IS NULL OR expires_at > now())
            AND (
              indexes -> $1 = to_jsonb($2::text)
              OR (
                jsonb_typeof(indexes -> $1) = 'array'
                AND (indexes -> $1) ? $2
              )
            )
          ORDER BY key
          LIMIT $4`,
        [input.index, input.value, after, limit + 1],
      );
      const page = result.rows.slice(0, limit);
      const last = page.at(-1);
      return {
        records: page.map(record),
        ...(result.rows.length > limit && last
          ? { cursor: encodeURIComponent(last.key) }
          : {}),
      };
    },
  };
}
