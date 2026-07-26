import { validateBundleArchive } from "@skillplane/storage";
import type { R2BundleRepository } from "@skillplane/storage";
import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest } from "./idempotency.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { Principal } from "./principal.js";
import {
  parseSemanticBump,
  toSkillVersionRecord,
  type SemanticBump,
} from "./skill-versions.js";
import { mapSkillInfrastructureError, type SkillVersionRecord } from "./skills.js";
import { withDomainTransaction as withTransaction } from "./transactions.js";
import { insertPrincipalAudit } from "./mutation-audit.js";

interface PublicationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly skill_id: string;
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
  readonly change_summary: string;
  readonly published_at: Date | null;
  readonly created_at: Date;
}

export function nextSemanticVersion(current: string, bump: SemanticBump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(current);
  if (!match) {
    throw new DomainError(
      "SKILL_PUBLISH_CONFLICT",
      "The current semantic version cannot be advanced",
      409,
    );
  }
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new DomainError(
      "SKILL_PUBLISH_CONFLICT",
      "The current semantic version cannot be advanced",
      409,
    );
  }
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${String(major)}.${String(minor)}.${String(patch)}`;
}

function isSemverConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "skill_versions_skill_semver_unique"
  );
}

export class PublicationService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: R2BundleRepository,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async publish(options: {
    readonly skillId: string;
    readonly candidateVersionId: string;
    readonly principal: Principal;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<SkillVersionRecord> {
    authorize(options.principal, "skills:publish");
    const requestHash = await hashIdempotentRequest({
      operation: "skill.version.publish",
      skillId: options.skillId,
      candidateVersionId: options.candidateVersionId,
    });
    const claim = await this.idempotency.claim<{ version: SkillVersionRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `skill.version.publish:${options.skillId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.version;

    try {
      const candidateResult = await this.pool.query<PublicationRow>(
        `SELECT id, workspace_id, skill_id, revision, semantic_version, status,
                base_version_id, proposed_bump, source, content_digest,
                r2_object_key, bundle_byte_size, manifest, change_summary,
                published_at, created_at
           FROM skill_versions
          WHERE id = $1 AND skill_id = $2 AND workspace_id = $3
          LIMIT 1`,
        [options.candidateVersionId, options.skillId, options.principal.workspaceId],
      );
      const candidate = candidateResult.rows[0];
      if (candidate?.status !== "pending_review") {
        throw new DomainError(
          "SKILL_VERSION_NOT_FOUND",
          "Candidate skill version was not found",
          404,
        );
      }
      const stored = await this.storage.getCanonicalBundle(
        candidate.r2_object_key,
        candidate.content_digest,
      );
      const bundle = await validateBundleArchive(stored.bytes);
      const skillMarkdown = bundle.files.get("SKILL.md");
      if (!skillMarkdown) {
        throw new DomainError(
          "SKILL_BUNDLE_INVALID",
          "Candidate bundle is missing SKILL.md",
          400,
        );
      }
      const instructions = new TextDecoder("utf-8", { fatal: true }).decode(
        skillMarkdown,
      );
      return await withTransaction(
        this.pool,
        options.requestId,
        async ({ client }) => {
          const locked = await client.query<
            PublicationRow & {
              readonly current_published_version_id: string | null;
              readonly current_semantic_version: string | null;
              readonly archived_at: Date | null;
            }
          >(
            `SELECT candidate.id, candidate.workspace_id, candidate.skill_id,
                    candidate.revision, candidate.semantic_version,
                    candidate.status, candidate.base_version_id,
                    candidate.proposed_bump, candidate.source,
                    candidate.content_digest, candidate.r2_object_key,
                    candidate.bundle_byte_size, candidate.manifest,
                    candidate.change_summary, candidate.published_at,
                    candidate.created_at, skill.current_published_version_id,
                    current.semantic_version AS current_semantic_version,
                    skill.archived_at
               FROM skills skill
               JOIN skill_versions candidate
                 ON candidate.id = $2 AND candidate.skill_id = skill.id
               LEFT JOIN skill_versions current
                 ON current.id = skill.current_published_version_id
              WHERE skill.id = $1 AND skill.workspace_id = $3
              FOR UPDATE OF skill, candidate`,
            [
              options.skillId,
              options.candidateVersionId,
              options.principal.workspaceId,
            ],
          );
          const row = locked.rows[0];
          if (row?.status !== "pending_review") {
            throw new DomainError(
              "SKILL_PUBLISH_CONFLICT",
              "The candidate is no longer publishable",
              409,
            );
          }
          if (row.archived_at) {
            throw new DomainError(
              "SKILL_ARCHIVED",
              "Archived skills cannot publish candidates",
              409,
            );
          }
          if (
            !row.current_published_version_id ||
            !row.current_semantic_version ||
            row.base_version_id !== row.current_published_version_id
          ) {
            throw new DomainError(
              "SKILL_PUBLISH_CONFLICT",
              "The published version changed after this candidate was created",
              409,
              { currentVersionId: row.current_published_version_id },
            );
          }
          const bump = parseSemanticBump(row.proposed_bump);
          const semanticVersion = nextSemanticVersion(
            row.current_semantic_version,
            bump,
          );
          const updated = await client.query<PublicationRow>(
            `UPDATE skill_versions
                SET semantic_version = $2, status = 'published',
                    published_at = now()
              WHERE id = $1 AND status = 'pending_review'
              RETURNING id, workspace_id, skill_id, revision, semantic_version,
                        status, base_version_id, proposed_bump, source,
                        content_digest, r2_object_key, bundle_byte_size,
                        manifest, change_summary, published_at, created_at`,
            [options.candidateVersionId, semanticVersion],
          );
          const version = updated.rows[0];
          if (!version) {
            throw new DomainError(
              "SKILL_PUBLISH_CONFLICT",
              "The candidate is no longer publishable",
              409,
            );
          }
          await client.query(
            `UPDATE skills
                SET current_published_version_id = $2,
                    published_search_text = $3,
                    updated_at = now()
              WHERE id = $1`,
            [options.skillId, options.candidateVersionId, instructions],
          );
          await insertPrincipalAudit(client, options.principal, {
            eventType: "skill.version.published",
            action: "skills:publish",
            requestId: options.requestId,
            resourceType: "skill_version",
            resourceId: options.candidateVersionId,
            skillId: options.skillId,
            versionId: options.candidateVersionId,
            metadata: {
              semanticVersion,
              bump,
              previousVersionId: row.current_published_version_id,
            },
          });
          const record = toSkillVersionRecord(version);
          await this.idempotency.complete(client, claim.identity, 200, {
            version: record,
          });
          return record;
        },
        { maxRetries: 0 },
      );
    } catch (error) {
      await this.idempotency.release(claim.identity).catch(() => undefined);
      if (isSemverConflict(error)) {
        throw new DomainError(
          "SKILL_PUBLISH_CONFLICT",
          "Another candidate won this semantic version",
          409,
        );
      }
      return mapSkillInfrastructureError(error);
    }
  }

  async reject(options: {
    readonly skillId: string;
    readonly candidateVersionId: string;
    readonly principal: Principal;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<SkillVersionRecord> {
    authorize(options.principal, "skills:publish");
    const reason = options.reason.trim();
    if (!reason || reason.length > 2000) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "A rejection reason between 1 and 2,000 characters is required",
        400,
      );
    }
    const requestHash = await hashIdempotentRequest({
      operation: "skill.version.reject",
      skillId: options.skillId,
      candidateVersionId: options.candidateVersionId,
      reason,
    });
    const claim = await this.idempotency.claim<{ version: SkillVersionRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `skill.version.reject:${options.skillId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.version;
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const result = await client.query<PublicationRow>(
          `UPDATE skill_versions version
                SET status = 'rejected'
               FROM skills skill
              WHERE version.id = $1 AND version.skill_id = $2
                AND version.workspace_id = $3
                AND skill.id = version.skill_id
                AND version.status = 'pending_review'
              RETURNING version.id, version.workspace_id, version.skill_id,
                        version.revision, version.semantic_version,
                        version.status, version.base_version_id,
                        version.proposed_bump, version.source,
                        version.content_digest, version.r2_object_key,
                        version.bundle_byte_size, version.manifest,
                        version.change_summary, version.published_at,
                        version.created_at`,
          [options.candidateVersionId, options.skillId, options.principal.workspaceId],
        );
        const row = result.rows[0];
        if (!row) {
          throw new DomainError(
            "SKILL_VERSION_NOT_FOUND",
            "Candidate skill version was not found",
            404,
          );
        }
        await insertPrincipalAudit(client, options.principal, {
          eventType: "skill.version.rejected",
          action: "skills:publish",
          requestId: options.requestId,
          resourceType: "skill_version",
          resourceId: options.candidateVersionId,
          skillId: options.skillId,
          versionId: options.candidateVersionId,
          metadata: { decisionReasonProvided: reason.trim().length > 0 },
        });
        const version = toSkillVersionRecord(row);
        await this.idempotency.complete(client, claim.identity, 200, {
          version,
        });
        return version;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity).catch(() => undefined);
      return mapSkillInfrastructureError(error);
    }
  }
}
