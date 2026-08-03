import { validateBundleArchive, type R2BundleRepository } from "@skillplane/storage";
import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import type { AmendmentPolicyDecision } from "./amendment-policy.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest, type IdempotencyStore } from "./idempotency.js";
import { principalAuditActor, type Principal } from "./principal.js";
import { nextSemanticVersion } from "./publication.js";
import {
  parseSemanticBump,
  toSkillVersionRecord,
  type SemanticBump,
} from "./skill-versions.js";
import { mapSkillInfrastructureError, type SkillVersionRecord } from "./skills.js";
import { withDomainTransaction } from "./transactions.js";
import { insertMutationAudit, type MutationAuditContext } from "./mutation-audit.js";

export type AmendmentReviewStatus = "pending" | "approved" | "rejected" | "superseded";

export interface AmendmentReviewRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly proposedVersionId: string;
  readonly status: AmendmentReviewStatus;
  readonly decisionReason: string | null;
  readonly policyDecision: AmendmentPolicyDecision | Readonly<Record<string, unknown>>;
  readonly requestedByActorType: "user" | "service_principal" | "system";
  readonly requestedByActorId: string;
  readonly requestedByAgent: string | null;
  readonly requestedByModel: string | null;
  readonly requestedForUserId: string | null;
  readonly reviewedByActorType: "user" | "service_principal" | "system" | null;
  readonly reviewedByActorId: string | null;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AmendmentReviewDetail {
  readonly review: AmendmentReviewRecord;
  readonly candidate: SkillVersionRecord;
}

interface ReviewRow {
  readonly review_id: string;
  readonly workspace_id: string;
  readonly skill_id: string;
  readonly proposed_version_id: string;
  readonly review_status: AmendmentReviewStatus;
  readonly decision_reason: string | null;
  readonly review_policy_decision: AmendmentReviewRecord["policyDecision"];
  readonly requested_by_actor_type: AmendmentReviewRecord["requestedByActorType"];
  readonly requested_by_actor_id: string;
  readonly requested_by_agent: string | null;
  readonly requested_by_model: string | null;
  readonly requested_for_user_id: string | null;
  readonly reviewed_by_actor_type: AmendmentReviewRecord["reviewedByActorType"];
  readonly reviewed_by_actor_id: string | null;
  readonly reviewed_by_user_id: string | null;
  readonly reviewed_at: Date | null;
  readonly review_created_at: Date;
  readonly review_updated_at: Date;
  readonly id: string;
  readonly revision: number;
  readonly semantic_version: string | null;
  readonly status: SkillVersionRecord["status"];
  readonly base_version_id: string | null;
  readonly proposed_bump: SemanticBump | null;
  readonly source: SkillVersionRecord["source"];
  readonly content_digest: `sha256:${string}`;
  readonly r2_object_key: string;
  readonly bundle_byte_size: string | number;
  readonly manifest: SkillVersionRecord["manifest"];
  readonly learning_metadata: SkillVersionRecord["learningMetadata"];
  readonly amendment_operations: SkillVersionRecord["amendmentOperations"];
  readonly caller_declaration: SkillVersionRecord["callerDeclaration"];
  readonly policy_decision: SkillVersionRecord["policyDecision"];
  readonly change_summary: string;
  readonly created_by_actor_type: SkillVersionRecord["createdByActorType"];
  readonly created_by_actor_id: string;
  readonly created_by_agent: string | null;
  readonly created_by_model: string | null;
  readonly created_for_user_id: string | null;
  readonly published_at: Date | null;
  readonly created_at: Date;
}

const REVIEW_SELECT = `
  SELECT review.id AS review_id, review.workspace_id, review.skill_id,
         review.proposed_version_id, review.status AS review_status,
         review.decision_reason,
         review.policy_decision AS review_policy_decision,
         review.requested_by_actor_type, review.requested_by_actor_id,
         review.requested_by_agent, review.requested_by_model,
         review.requested_for_user_id, review.reviewed_by_actor_type,
         review.reviewed_by_actor_id, review.reviewed_by_user_id,
         review.reviewed_at, review.created_at AS review_created_at,
         review.updated_at AS review_updated_at,
         version.id, version.revision, version.semantic_version,
         version.status, version.base_version_id, version.proposed_bump,
         version.source, version.content_digest, version.r2_object_key,
         version.bundle_byte_size, version.manifest, version.learning_metadata,
         version.amendment_operations, version.caller_declaration,
         version.policy_decision, version.change_summary,
         version.created_by_actor_type, version.created_by_actor_id,
         version.created_by_agent, version.created_by_model,
         version.created_for_user_id, version.published_at, version.created_at
    FROM amendment_reviews review
    JOIN skill_versions version
      ON version.id = review.proposed_version_id
     AND version.workspace_id = review.workspace_id`;

function toRecord(row: ReviewRow): AmendmentReviewRecord {
  return {
    id: row.review_id,
    workspaceId: row.workspace_id,
    skillId: row.skill_id,
    proposedVersionId: row.proposed_version_id,
    status: row.review_status,
    decisionReason: row.decision_reason,
    policyDecision: row.review_policy_decision,
    requestedByActorType: row.requested_by_actor_type,
    requestedByActorId: row.requested_by_actor_id,
    requestedByAgent: row.requested_by_agent,
    requestedByModel: row.requested_by_model,
    requestedForUserId: row.requested_for_user_id,
    reviewedByActorType: row.reviewed_by_actor_type,
    reviewedByActorId: row.reviewed_by_actor_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    createdAt: row.review_created_at.toISOString(),
    updatedAt: row.review_updated_at.toISOString(),
  };
}

function toDetail(row: ReviewRow): AmendmentReviewDetail {
  return {
    review: toRecord(row),
    candidate: toSkillVersionRecord(row),
  };
}

function decisionReason(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 2_000) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "A review reason between 1 and 2,000 characters is required",
      400,
      { field: "reason" },
    );
  }
  return value.trim();
}

function semverConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "skill_versions_skill_semver_unique"
  );
}

export class AmendmentReviewService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: R2BundleRepository,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async list(options: {
    readonly skillId: string;
    readonly principal: Principal;
    readonly status?: AmendmentReviewStatus | "all";
    readonly limit?: number;
  }): Promise<readonly AmendmentReviewDetail[]> {
    authorize(options.principal, "skills:read");
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
    const status = options.status ?? "all";
    if (
      status !== "all" &&
      !["pending", "approved", "rejected", "superseded"].includes(status)
    ) {
      throw new DomainError("VALIDATION_FAILED", "Review status is invalid", 400);
    }
    const result = await this.pool.query<ReviewRow>(
      `${REVIEW_SELECT}
        WHERE review.workspace_id = $1 AND review.skill_id = $2
          AND ($3::text = 'all' OR review.status = $3)
        ORDER BY review.created_at DESC, review.id DESC
        LIMIT $4`,
      [options.principal.workspaceId, options.skillId, status, limit],
    );
    if (result.rows.length === 0) {
      const skill = await this.pool.query(
        "SELECT 1 FROM skills WHERE id = $1 AND workspace_id = $2",
        [options.skillId, options.principal.workspaceId],
      );
      if (!skill.rows[0]) {
        throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
      }
    }
    return result.rows.map(toDetail);
  }

  async get(options: {
    readonly skillId: string;
    readonly reviewId: string;
    readonly principal: Principal;
  }): Promise<AmendmentReviewDetail> {
    authorize(options.principal, "skills:read");
    const result = await this.pool.query<ReviewRow>(
      `${REVIEW_SELECT}
        WHERE review.workspace_id = $1 AND review.skill_id = $2
          AND review.id = $3
        LIMIT 1`,
      [options.principal.workspaceId, options.skillId, options.reviewId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("REVIEW_NOT_FOUND", "Review was not found", 404);
    return toDetail(row);
  }

  async approve(options: {
    readonly skillId: string;
    readonly reviewId: string;
    readonly principal: Principal;
    readonly reason: unknown;
    readonly expectedUpdatedAt?: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly auditContext?: MutationAuditContext;
  }): Promise<AmendmentReviewDetail> {
    authorize(options.principal, "skills:publish");
    const reason = decisionReason(options.reason);
    return this.decide({ ...options, reason, decision: "approved" });
  }

  async reject(options: {
    readonly skillId: string;
    readonly reviewId: string;
    readonly principal: Principal;
    readonly reason: unknown;
    readonly expectedUpdatedAt?: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly auditContext?: MutationAuditContext;
  }): Promise<AmendmentReviewDetail> {
    authorize(options.principal, "skills:publish");
    const reason = decisionReason(options.reason);
    return this.decide({ ...options, reason, decision: "rejected" });
  }

  private async decide(options: {
    readonly skillId: string;
    readonly reviewId: string;
    readonly principal: Principal;
    readonly reason: string;
    readonly decision: "approved" | "rejected";
    readonly expectedUpdatedAt?: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly auditContext?: MutationAuditContext;
  }): Promise<AmendmentReviewDetail> {
    const expectedUpdatedAt = (() => {
      if (options.expectedUpdatedAt === undefined) return undefined;
      const timestamp = Date.parse(options.expectedUpdatedAt);
      if (!Number.isFinite(timestamp)) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "expectedUpdatedAt must be an ISO 8601 timestamp",
          400,
          { field: "expectedUpdatedAt" },
        );
      }
      return new Date(timestamp).toISOString();
    })();
    const requestHash = await hashIdempotentRequest({
      operation: `amendment.review.${options.decision}`,
      skillId: options.skillId,
      reviewId: options.reviewId,
      reason: options.reason,
      expectedUpdatedAt: expectedUpdatedAt ?? null,
    });
    const claim = await this.idempotency.claim<{ detail: AmendmentReviewDetail }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `amendment.review.${options.decision}:${options.reviewId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.detail;
    try {
      let instructions: string | null = null;
      if (options.decision === "approved") {
        const existing = await this.get({
          skillId: options.skillId,
          reviewId: options.reviewId,
          principal: options.principal,
        });
        if (existing.review.status !== "pending") {
          throw new DomainError(
            "SKILL_PUBLISH_CONFLICT",
            "The amendment review is no longer pending",
            409,
          );
        }
        const stored = await this.storage.getCanonicalBundle(
          existing.candidate.objectKey,
          existing.candidate.digest,
        );
        const bundle = await validateBundleArchive(stored.bytes);
        const markdown = bundle.files.get("SKILL.md");
        if (!markdown) {
          throw new DomainError(
            "SKILL_BUNDLE_INVALID",
            "Candidate bundle is missing SKILL.md",
            400,
          );
        }
        instructions = new TextDecoder("utf-8", { fatal: true }).decode(markdown);
      }
      const actor = principalAuditActor(options.principal);
      return await withDomainTransaction(
        this.pool,
        options.requestId,
        async ({ client }) => {
          const locked = await client.query<
            ReviewRow & {
              readonly current_published_version_id: string | null;
              readonly current_semantic_version: string | null;
              readonly archived_at: Date | null;
            }
          >(
            `${REVIEW_SELECT}
              JOIN skills skill ON skill.id = review.skill_id
              LEFT JOIN skill_versions current
                ON current.id = skill.current_published_version_id
             WHERE review.workspace_id = $1 AND review.skill_id = $2
               AND review.id = $3
             FOR UPDATE OF review, version, skill`,
            [options.principal.workspaceId, options.skillId, options.reviewId],
          );
          const row = locked.rows[0];
          if (!row) {
            throw new DomainError("REVIEW_NOT_FOUND", "Review was not found", 404);
          }
          if (row.review_status !== "pending" || row.status !== "pending_review") {
            throw new DomainError(
              "SKILL_PUBLISH_CONFLICT",
              "The amendment review is no longer pending",
              409,
            );
          }
          if (
            expectedUpdatedAt !== undefined &&
            row.review_updated_at.toISOString() !== expectedUpdatedAt
          ) {
            throw new DomainError(
              "SKILL_PUBLISH_CONFLICT",
              "The amendment review changed after it was read",
              409,
              { currentUpdatedAt: row.review_updated_at.toISOString() },
            );
          }
          let semanticVersion: string | null = null;
          if (options.decision === "approved") {
            const state = await client.query<{
              current_published_version_id: string | null;
              current_semantic_version: string | null;
              archived_at: Date | null;
            }>(
              `SELECT skill.current_published_version_id,
                      current.semantic_version AS current_semantic_version,
                      skill.archived_at
                 FROM skills skill
                 LEFT JOIN skill_versions current
                   ON current.id = skill.current_published_version_id
                WHERE skill.id = $1 AND skill.workspace_id = $2
                FOR UPDATE OF skill`,
              [options.skillId, options.principal.workspaceId],
            );
            const current = state.rows[0];
            if (current?.archived_at) {
              throw new DomainError(
                "SKILL_ARCHIVED",
                "Archived skills cannot publish candidates",
                409,
              );
            }
            if (
              !current?.current_published_version_id ||
              !current.current_semantic_version ||
              row.base_version_id !== current.current_published_version_id
            ) {
              throw new DomainError(
                "SKILL_PUBLISH_CONFLICT",
                "The published version changed after this candidate was created",
                409,
                { currentVersionId: current?.current_published_version_id ?? null },
              );
            }
            semanticVersion = nextSemanticVersion(
              current.current_semantic_version,
              parseSemanticBump(row.proposed_bump),
            );
            await client.query(
              `UPDATE skill_versions
                  SET status = 'published', semantic_version = $2,
                      published_at = now()
                WHERE id = $1 AND status = 'pending_review'`,
              [row.id, semanticVersion],
            );
            await client.query(
              `UPDATE skills
                  SET current_published_version_id = $2,
                      published_search_text = $3, updated_at = now()
                WHERE id = $1`,
              [options.skillId, row.id, instructions],
            );
          } else {
            await client.query(
              `UPDATE skill_versions SET status = 'rejected'
                WHERE id = $1 AND status = 'pending_review'`,
              [row.id],
            );
          }
          await client.query(
            `UPDATE amendment_reviews
                SET status = $2, decision_reason = $3,
                    reviewed_by_actor_type = $4, reviewed_by_actor_id = $5,
                    reviewed_by_user_id = $6, reviewed_at = now(), updated_at = now()
              WHERE id = $1 AND status = 'pending'`,
            [
              options.reviewId,
              options.decision,
              options.reason,
              actor.actorType,
              actor.actorId,
              options.principal.kind === "user" ? options.principal.userId : null,
            ],
          );
          await insertMutationAudit(client, options.principal, options.auditContext, {
            eventType: `amendment.review.${options.decision}`,
            action: "skills:publish",
            requestId: options.requestId,
            resourceType: "amendment_review",
            resourceId: options.reviewId,
            skillId: options.skillId,
            versionId: row.id,
            metadata: {
              decisionReasonProvided: options.reason.trim().length > 0,
              semanticVersion,
            },
          });
          const final = await client.query<ReviewRow>(
            `${REVIEW_SELECT}
              WHERE review.id = $1 AND review.workspace_id = $2
              LIMIT 1`,
            [options.reviewId, options.principal.workspaceId],
          );
          const finalRow = final.rows[0];
          if (!finalRow) {
            throw new DomainError(
              "REVIEW_NOT_FOUND",
              "Amendment review was not found",
              404,
            );
          }
          const detail = toDetail(finalRow);
          await this.idempotency.complete(client, claim.identity, 200, { detail });
          return detail;
        },
      );
    } catch (error) {
      await this.idempotency.release(claim.identity).catch(() => undefined);
      if (semverConflict(error)) {
        throw new DomainError(
          "SKILL_PUBLISH_CONFLICT",
          "Another candidate won this semantic version",
          409,
        );
      }
      return mapSkillInfrastructureError(error);
    }
  }
}
