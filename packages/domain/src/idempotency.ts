import { stableJson } from "@skillplane/storage";
import type { Pool, PoolClient } from "pg";
import { DomainError } from "./errors.js";
import type { Principal } from "./principal.js";
import { withDomainTransaction } from "./transactions.js";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

export interface IdempotencyIdentity {
  readonly workspaceId: string;
  readonly principalKey: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: string;
}

export type IdempotencyClaim<T extends Record<string, unknown>> =
  | {
      readonly state: "claimed";
      readonly identity: IdempotencyIdentity;
    }
  | {
      readonly state: "replay";
      readonly responseStatus: number;
      readonly responseBody: T;
    };

export function validateIdempotencyKey(value: string | null | undefined): string {
  const normalized = value?.trim();
  if (!normalized || !IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A valid Idempotency-Key header is required",
      400,
    );
  }
  return normalized;
}

export function principalIdempotencyKey(principal: Principal): string {
  return `${principal.kind}:${principal.actorId}`;
}

export async function hashIdempotentRequest(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(stableJson(value));
  const input = new Uint8Array(encoded.byteLength);
  input.set(encoded);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class IdempotencyStore {
  constructor(
    private readonly pool: Pool,
    private readonly lockDurationMs = 30_000,
    private readonly retentionMs = 24 * 60 * 60 * 1000,
  ) {}

  async claim<T extends Record<string, unknown>>(options: {
    readonly workspaceId: string;
    readonly principal: Principal;
    readonly operation: string;
    readonly key: string;
    readonly requestHash: string;
    readonly fencingEpoch?: number | undefined;
    readonly now?: Date;
  }): Promise<IdempotencyClaim<T>> {
    const key = validateIdempotencyKey(options.key);
    const principalKey = principalIdempotencyKey(options.principal);
    const now = options.now ?? new Date();
    const lockedUntil = new Date(now.getTime() + this.lockDurationMs);
    const expiresAt = new Date(now.getTime() + this.retentionMs);
    const identity: IdempotencyIdentity = {
      workspaceId: options.workspaceId,
      principalKey,
      operation: options.operation,
      key,
      requestHash: options.requestHash,
    };
    return withDomainTransaction(
      this.pool,
      `idempotency:${options.operation}`,
      async ({ client }) => {
        const inserted = await client.query(
          `INSERT INTO idempotency_records
         (workspace_id, principal_key, key, operation, request_hash,
          locked_until, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, principal_key, key, operation) DO NOTHING
       RETURNING key`,
          [
            options.workspaceId,
            principalKey,
            key,
            options.operation,
            options.requestHash,
            lockedUntil,
            expiresAt,
          ],
        );
        if (inserted.rowCount === 1) return { state: "claimed", identity };

        const current = await client.query<{
          request_hash: string;
          response_status: number | null;
          response_body: T | null;
          locked_until: Date;
        }>(
          `SELECT request_hash, response_status, response_body, locked_until
         FROM idempotency_records
        WHERE workspace_id = $1 AND principal_key = $2
          AND key = $3 AND operation = $4`,
          [options.workspaceId, principalKey, key, options.operation],
        );
        const record = current.rows[0];
        if (!record) {
          throw new DomainError(
            "IDEMPOTENCY_IN_PROGRESS",
            "The idempotent operation could not be claimed",
            409,
          );
        }
        if (record.request_hash !== options.requestHash) {
          throw new DomainError(
            "IDEMPOTENCY_KEY_REUSED",
            "The idempotency key was already used with different input",
            409,
          );
        }
        if (record.response_status !== null && record.response_body !== null) {
          return {
            state: "replay",
            responseStatus: record.response_status,
            responseBody: record.response_body,
          };
        }
        if (record.locked_until > now) {
          throw new DomainError(
            "IDEMPOTENCY_IN_PROGRESS",
            "An identical operation is still in progress",
            409,
          );
        }
        const reclaimed = await client.query(
          `UPDATE idempotency_records
          SET locked_until = $5, expires_at = $6, updated_at = now()
        WHERE workspace_id = $1 AND principal_key = $2
          AND key = $3 AND operation = $4
          AND request_hash = $7 AND response_status IS NULL
          AND locked_until <= $8
        RETURNING key`,
          [
            options.workspaceId,
            principalKey,
            key,
            options.operation,
            lockedUntil,
            expiresAt,
            options.requestHash,
            now,
          ],
        );
        if (reclaimed.rowCount !== 1) {
          throw new DomainError(
            "IDEMPOTENCY_IN_PROGRESS",
            "An identical operation is still in progress",
            409,
          );
        }
        return { state: "claimed", identity };
      },
      {
        isolation: "read committed",
        fencingEpoch: options.fencingEpoch,
      },
    );
  }

  async complete(
    client: PoolClient,
    identity: IdempotencyIdentity,
    responseStatus: number,
    responseBody: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE idempotency_records
          SET response_status = $6, response_body = $7,
              locked_until = now(), updated_at = now()
        WHERE workspace_id = $1 AND principal_key = $2
          AND key = $3 AND operation = $4 AND request_hash = $5
          AND response_status IS NULL`,
      [
        identity.workspaceId,
        identity.principalKey,
        identity.key,
        identity.operation,
        identity.requestHash,
        responseStatus,
        responseBody,
      ],
    );
    if (result.rowCount !== 1) {
      throw new DomainError(
        "IDEMPOTENCY_KEY_REUSED",
        "The idempotency record could not be completed",
        409,
      );
    }
  }

  async release(identity: IdempotencyIdentity, fencingEpoch?: number): Promise<void> {
    await withDomainTransaction(
      this.pool,
      `idempotency-release:${identity.operation}`,
      async ({ client }) =>
        client.query(
          `DELETE FROM idempotency_records
        WHERE workspace_id = $1 AND principal_key = $2
          AND key = $3 AND operation = $4 AND request_hash = $5
          AND response_status IS NULL`,
          [
            identity.workspaceId,
            identity.principalKey,
            identity.key,
            identity.operation,
            identity.requestHash,
          ],
        ),
      { isolation: "read committed", fencingEpoch },
    );
  }
}
