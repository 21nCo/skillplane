import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest, type IdempotencyStore } from "./idempotency.js";
import { insertPrincipalAudit } from "./mutation-audit.js";
import type { Principal } from "./principal.js";
import { withDomainTransaction } from "./transactions.js";
export class VersionLifecycleService {
  constructor(
    readonly pool: Pool,
    readonly controlPool: Pool,
    readonly idempotency: IdempotencyStore,
  ) {}
  async set(options: {
    skillId: string;
    versionId: string;
    state: "deprecated" | "revoked";
    reason: string;
    principal: Principal;
    idempotencyKey: string;
    requestId: string;
    fencingEpoch?: number;
  }) {
    authorize(options.principal, "skills:publish");
    const reason = options.reason.trim();
    if (
      !reason ||
      reason.length > 2000 ||
      !["deprecated", "revoked"].includes(options.state)
    )
      throw new DomainError(
        "VALIDATION_FAILED",
        "A lifecycle state and reason are required",
        400,
      );
    const payload = {
      skillId: options.skillId,
      versionId: options.versionId,
      state: options.state,
      reason,
    };
    const claim = await this.idempotency.claim<{ result: typeof payload }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: "skill.version.lifecycle",
      key: options.idempotencyKey,
      requestHash: await hashIdempotentRequest(payload),
      fencingEpoch: options.fencingEpoch,
    });
    if (claim.state === "replay") return claim.responseBody.result;
    try {
      const source = await this.pool.query(
        "SELECT 1 FROM skill_versions WHERE id=$1 AND skill_id=$2 AND workspace_id=$3 AND status='published'",
        [options.versionId, options.skillId, options.principal.workspaceId],
      );
      if (!source.rowCount)
        throw new DomainError(
          "NOT_FOUND",
          "Published skill version was not found",
          404,
        );
      // Publish the fail-closed invalidation before acknowledging any regional state.
      await this.controlPool.query(
        `INSERT INTO public_skill_version_lifecycle (version_id,workspace_id,deprecated_at,revoked_at,reason)
        VALUES ($1,$2,CASE WHEN $3='deprecated' THEN now() END,CASE WHEN $3='revoked' THEN now() END,$4)
        ON CONFLICT (version_id) DO UPDATE SET deprecated_at=COALESCE(public_skill_version_lifecycle.deprecated_at,EXCLUDED.deprecated_at),revoked_at=COALESCE(public_skill_version_lifecycle.revoked_at,EXCLUDED.revoked_at),reason=EXCLUDED.reason,updated_at=now()`,
        [options.versionId, options.principal.workspaceId, options.state, reason],
      );
      return await withDomainTransaction(
        this.pool,
        options.requestId,
        async ({ client }) => {
          await client.query(
            `INSERT INTO skill_version_lifecycle (version_id,workspace_id,deprecated_at,revoked_at,reason)
          VALUES ($1,$2,CASE WHEN $3='deprecated' THEN now() END,CASE WHEN $3='revoked' THEN now() END,$4)
          ON CONFLICT (version_id) DO UPDATE SET deprecated_at=COALESCE(skill_version_lifecycle.deprecated_at,EXCLUDED.deprecated_at),revoked_at=COALESCE(skill_version_lifecycle.revoked_at,EXCLUDED.revoked_at),reason=EXCLUDED.reason`,
            [options.versionId, options.principal.workspaceId, options.state, reason],
          );
          await insertPrincipalAudit(client, options.principal, {
            eventType: `skill.version.${options.state}`,
            action: "skills:publish",
            requestId: options.requestId,
            resourceType: "skill_version",
            resourceId: options.versionId,
            skillId: options.skillId,
            versionId: options.versionId,
            metadata: { reason },
          });
          await this.idempotency.complete(client, claim.identity, 200, {
            result: payload,
          });
          return payload;
        },
        { fencingEpoch: options.fencingEpoch },
      );
    } catch (error) {
      await this.idempotency
        .release(claim.identity, options.fencingEpoch)
        .catch(() => undefined);
      throw error;
    }
  }
}
