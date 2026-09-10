import {
  BundlePathError,
  BundleValidationError,
  canonicalizeBundleFiles,
  normalizeBundlePath,
  sha256Hex,
  validateBundleArchive,
  type R2BundleRepository,
} from "@skillplane/storage";
import type { Pool } from "pg";
import {
  countRuleAutoPublications,
  evaluateAmendmentPolicy,
  parseAmendmentPolicy,
  type AmendmentPolicyDecision,
} from "./amendment-policy.js";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest, type IdempotencyStore } from "./idempotency.js";
import { parseLearningMetadata, type LearningMetadata } from "./learning-metadata.js";
import { insertMutationAudit, type MutationAuditContext } from "./mutation-audit.js";
import { principalAuditActor, type Principal } from "./principal.js";
import { nextSemanticVersion } from "./publication.js";
import { enqueueCurrentSkillProjection } from "./projection-events.js";
import type { AmendmentReviewDetail, AmendmentReviewRecord } from "./reviews.js";
import { parseSemanticBump } from "./skill-versions.js";
import { mapSkillInfrastructureError, type SkillVersionRecord } from "./skills.js";
import { withDomainTransaction } from "./transactions.js";

export type AmendmentFileOperationName = "add" | "replace" | "delete";

export interface AmendmentFileOperation {
  readonly operation: AmendmentFileOperationName;
  readonly path: string;
  readonly expectedSha256: string | null;
  readonly contentBase64: string | null;
}

export interface CallerDeclaration {
  readonly agent: string;
  readonly model: string;
  readonly client: string;
  readonly runId: string;
  readonly sessionId: string | null;
  readonly conversationId: string | null;
  readonly forUserId: string | null;
}

export interface AmendmentResult extends AmendmentReviewDetail {
  readonly policyDecision: AmendmentPolicyDecision;
  readonly autoPublished: boolean;
}

const CALLER_KEYS = new Set([
  "agent",
  "model",
  "client",
  "runId",
  "sessionId",
  "conversationId",
  "forUserId",
]);
const OPERATION_KEYS = new Set([
  "operation",
  "path",
  "expectedSha256",
  "content",
  "contentBase64",
]);

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be an object`, 400, {
      field,
    });
  }
  return value as Record<string, unknown>;
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  if (key) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${field}.${key} is not supported`,
      400,
      { field: `${field}.${key}` },
    );
  }
}

function declaredText(value: unknown, field: string, required = true): string | null {
  if (value === null || value === undefined) {
    if (!required) return null;
    throw new DomainError("VALIDATION_FAILED", `${field} is required`, 400, {
      field,
    });
  }
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", `${field} must be text`, 400, {
      field,
    });
  }
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > 200) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${field} must be ${required ? "between 1 and" : "at most"} 200 characters`,
      400,
      { field },
    );
  }
  return normalized || null;
}

function requiredDeclaredText(value: unknown, field: string): string {
  const result = declaredText(value, field);
  if (result === null) {
    throw new DomainError("VALIDATION_FAILED", `${field} is required`, 400, {
      field,
    });
  }
  return result;
}

export function parseCallerDeclaration(
  value: unknown,
  principal: Principal,
): CallerDeclaration {
  const caller = object(value, "caller");
  strictKeys(caller, CALLER_KEYS, "caller");
  const declaredForUserId = declaredText(caller.forUserId, "caller.forUserId", false);
  if (
    principal.kind === "user" &&
    declaredForUserId &&
    declaredForUserId !== principal.userId
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "Declared user attribution cannot replace the authenticated user",
      403,
      { field: "caller.forUserId" },
    );
  }
  const forUserId =
    declaredForUserId ??
    (principal.kind === "user"
      ? principal.userId
      : (principal.delegatedUserId ?? null));
  return {
    agent: requiredDeclaredText(caller.agent, "caller.agent"),
    model: requiredDeclaredText(caller.model, "caller.model"),
    client: requiredDeclaredText(caller.client, "caller.client"),
    runId: requiredDeclaredText(caller.runId, "caller.runId"),
    sessionId: declaredText(caller.sessionId, "caller.sessionId", false),
    conversationId: declaredText(caller.conversationId, "caller.conversationId", false),
    forUserId,
  };
}

function decodeBase64(value: string, field: string): Uint8Array {
  if (
    value.length > 8 * 1024 * 1024 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new DomainError("VALIDATION_FAILED", `${field} is invalid base64`, 400, {
      field,
    });
  }
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new DomainError("VALIDATION_FAILED", `${field} is invalid base64`, 400, {
      field,
    });
  }
}

function operationContent(operation: AmendmentFileOperation): string {
  if (operation.contentBase64 === null) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "changes.contentBase64 is required for add and replace operations",
      400,
      { field: "changes.contentBase64" },
    );
  }
  return operation.contentBase64;
}

export function parseAmendmentOperations(
  value: unknown,
): readonly AmendmentFileOperation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "changes must contain between 1 and 100 file operations",
      400,
      { field: "changes" },
    );
  }
  const paths = new Set<string>();
  return value.map((entry, index) => {
    const field = `changes[${String(index)}]`;
    const row = object(entry, field);
    strictKeys(row, OPERATION_KEYS, field);
    if (!["add", "replace", "delete"].includes(String(row.operation))) {
      throw new DomainError(
        "VALIDATION_FAILED",
        `${field}.operation must be add, replace, or delete`,
        400,
        { field: `${field}.operation` },
      );
    }
    let path: string;
    try {
      path = normalizeBundlePath(requiredDeclaredText(row.path, `${field}.path`));
    } catch (error) {
      if (error instanceof BundlePathError) {
        throw new DomainError(error.code, error.message, 400, {
          field: `${field}.path`,
        });
      }
      throw error;
    }
    if (path === "skill.json") {
      throw new DomainError(
        "VALIDATION_FAILED",
        "skill.json is generated and cannot be amended directly",
        400,
        { field: `${field}.path` },
      );
    }
    const collision = path.toLocaleLowerCase("en");
    if (paths.has(collision)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Each amended path may appear only once",
        400,
        { field: `${field}.path` },
      );
    }
    paths.add(collision);
    const operation = row.operation as AmendmentFileOperationName;
    const expected =
      row.expectedSha256 === null || row.expectedSha256 === undefined
        ? null
        : declaredText(row.expectedSha256, `${field}.expectedSha256`);
    if (
      (operation === "add" && expected !== null) ||
      (operation !== "add" && (expected === null || !/^[a-f0-9]{64}$/u.test(expected)))
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        operation === "add"
          ? "Add operations require expectedSha256 to be null"
          : "Replace and delete operations require a SHA-256 digest",
        400,
        { field: `${field}.expectedSha256` },
      );
    }
    const hasText = typeof row.content === "string";
    const hasBase64 = typeof row.contentBase64 === "string";
    if (operation === "delete" ? hasText || hasBase64 : hasText === hasBase64) {
      throw new DomainError(
        "VALIDATION_FAILED",
        operation === "delete"
          ? "Delete operations cannot include content"
          : "Add and replace operations require exactly one content encoding",
        400,
        { field },
      );
    }
    let contentBase64: string | null = null;
    if (operation !== "delete") {
      if (hasText) {
        const encoded = new TextEncoder().encode(row.content as string);
        contentBase64 = btoa(
          [...encoded].map((byte) => String.fromCharCode(byte)).join(""),
        );
      } else {
        const bytes = decodeBase64(
          row.contentBase64 as string,
          `${field}.contentBase64`,
        );
        contentBase64 = btoa(
          [...bytes].map((byte) => String.fromCharCode(byte)).join(""),
        );
      }
    }
    return { operation, path, expectedSha256: expected, contentBase64 };
  });
}

export async function applyAmendmentOperations(
  baseFiles: ReadonlyMap<string, Uint8Array>,
  operations: readonly AmendmentFileOperation[],
): Promise<ReadonlyMap<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>(
    [...baseFiles.entries()]
      .filter(([path]) => path !== "skill.json")
      .map(([path, bytes]) => [path, bytes.slice()] as const),
  );
  for (const operation of operations) {
    const current = files.get(operation.path);
    if (operation.operation === "add") {
      if (current) {
        throw new DomainError(
          "SKILL_VERSION_CONFLICT",
          `Cannot add existing file ${operation.path}`,
          409,
          { path: operation.path },
        );
      }
      files.set(
        operation.path,
        decodeBase64(operationContent(operation), "changes.contentBase64"),
      );
      continue;
    }
    if (!current || (await sha256Hex(current)) !== operation.expectedSha256) {
      throw new DomainError(
        "SKILL_VERSION_CONFLICT",
        `Expected digest does not match ${operation.path}`,
        409,
        { path: operation.path },
      );
    }
    if (operation.operation === "delete") {
      files.delete(operation.path);
    } else {
      files.set(
        operation.path,
        decodeBase64(operationContent(operation), "changes.contentBase64"),
      );
    }
  }
  return files;
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export class AmendmentService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: R2BundleRepository,
    private readonly idempotency: IdempotencyStore,
    private readonly controlPool: Pool = pool,
  ) {}

  async amend(options: {
    readonly skillId: string;
    readonly principal: Principal;
    readonly baseVersionId: string;
    readonly proposedBump: unknown;
    readonly changes: unknown;
    readonly learning: unknown;
    readonly caller: unknown;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly fencingEpoch?: number;
    readonly auditContext?: MutationAuditContext;
  }): Promise<AmendmentResult> {
    authorize(options.principal, "skills:amend");
    const proposedBump = parseSemanticBump(options.proposedBump);
    const changes = parseAmendmentOperations(options.changes);
    const parsedLearning = parseLearningMetadata(options.learning);
    const caller = parseCallerDeclaration(options.caller, options.principal);
    const requestHash = await hashIdempotentRequest({
      operation: "skill.amend",
      skillId: options.skillId,
      baseVersionId: options.baseVersionId,
      proposedBump,
      changes,
      learning: parsedLearning,
      caller,
    });
    const claim = await this.idempotency.claim<{ result: AmendmentResult }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `skill.amend:${options.skillId}`,
      key: options.idempotencyKey,
      requestHash,
      fencingEpoch: options.fencingEpoch,
    });
    if (claim.state === "replay") return claim.responseBody.result;

    let stored: Awaited<ReturnType<R2BundleRepository["putCanonicalBundle"]>> | null =
      null;
    try {
      await this.validateDeclaredUser(options.principal.workspaceId, caller);
      const base = await this.pool.query<{
        readonly current_published_version_id: string | null;
        readonly archived_at: Date | null;
        readonly content_digest: `sha256:${string}` | null;
        readonly r2_object_key: string | null;
        readonly amendment_policy: unknown;
      }>(
        `SELECT skill.current_published_version_id, skill.archived_at,
                base.content_digest, base.r2_object_key, skill.amendment_policy
           FROM skills skill
           LEFT JOIN skill_versions base
             ON base.id = $3 AND base.skill_id = skill.id
          WHERE skill.id = $1 AND skill.workspace_id = $2
          LIMIT 1`,
        [options.skillId, options.principal.workspaceId, options.baseVersionId],
      );
      const baseRow = base.rows[0];
      if (!baseRow) {
        throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
      }
      if (baseRow.archived_at) {
        throw new DomainError(
          "SKILL_ARCHIVED",
          "Archived skills cannot receive amendments",
          409,
        );
      }
      if (
        baseRow.current_published_version_id !== options.baseVersionId ||
        !baseRow.content_digest ||
        !baseRow.r2_object_key
      ) {
        throw new DomainError(
          "SKILL_VERSION_CONFLICT",
          "The base version is no longer current",
          409,
          { currentVersionId: baseRow.current_published_version_id },
        );
      }
      const storedBase = await this.storage.getCanonicalBundle(
        baseRow.r2_object_key,
        baseRow.content_digest,
      );
      const validatedBase = await validateBundleArchive(storedBase.bytes);
      const amendedFiles = await applyAmendmentOperations(validatedBase.files, changes);
      const canonical = await canonicalizeBundleFiles({
        skill: {
          formatVersion: validatedBase.skill.formatVersion,
          name: validatedBase.skill.name,
          slug: validatedBase.skill.slug,
          description: validatedBase.skill.description,
          tags: validatedBase.skill.tags,
          entrypoint: "SKILL.md",
        },
        files: amendedFiles,
      });
      if (canonical.digest === baseRow.content_digest) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "The amendment does not change the canonical bundle",
          400,
        );
      }
      const provenanceOperations = changes.map((change) => ({
        operation: change.operation,
        path: change.path,
        expectedSha256: change.expectedSha256,
        resultSha256:
          canonical.manifest.files.find((file) => file.path === change.path)?.sha256 ??
          null,
      }));
      const context = await this.resolveContextSource({
        workspaceId: options.principal.workspaceId,
        skillId: options.skillId,
        learning: parsedLearning,
      });
      const learning: LearningMetadata = {
        ...parsedLearning,
        sourceContextRevisionId: context?.revisionId ?? null,
        sourceContextDigest: context?.digest ?? null,
      };
      const storedBundle = await this.storage.putCanonicalBundle(
        options.principal.workspaceId,
        options.skillId,
        canonical.digest,
        canonical.bytes,
      );
      stored = storedBundle;
      const markdown = canonical.files.get("SKILL.md");
      if (!markdown) {
        throw new DomainError(
          "SKILL_BUNDLE_INVALID",
          "Amendment removed the required SKILL.md file",
          400,
        );
      }
      const instructions = new TextDecoder("utf-8", { fatal: true }).decode(markdown);
      const actor = principalAuditActor(options.principal);
      const result = await withDomainTransaction(
        this.pool,
        options.requestId,
        async ({ client }) => {
          const skill = await client.query<{
            readonly current_published_version_id: string | null;
            readonly current_semantic_version: string | null;
            readonly next_revision: number;
            readonly archived_at: Date | null;
            readonly amendment_policy: unknown;
          }>(
            `SELECT skill.current_published_version_id,
                    current.semantic_version AS current_semantic_version,
                    skill.next_revision, skill.archived_at, skill.amendment_policy
               FROM skills skill
               LEFT JOIN skill_versions current
                 ON current.id = skill.current_published_version_id
              WHERE skill.id = $1 AND skill.workspace_id = $2
              FOR UPDATE OF skill`,
            [options.skillId, options.principal.workspaceId],
          );
          const skillRow = skill.rows[0];
          if (!skillRow) {
            throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
          }
          if (skillRow.archived_at) {
            throw new DomainError(
              "SKILL_ARCHIVED",
              "Archived skills cannot receive amendments",
              409,
            );
          }
          if (
            skillRow.current_published_version_id !== options.baseVersionId ||
            !skillRow.current_semantic_version
          ) {
            throw new DomainError(
              "SKILL_VERSION_CONFLICT",
              "The base version is no longer current",
              409,
              { currentVersionId: skillRow.current_published_version_id },
            );
          }
          if (learning.sourceContextId) {
            const lockedContext = await client.query<{
              current_knowledge_revision_id: string | null;
            }>(
              `SELECT current_knowledge_revision_id
                 FROM skill_contexts
                WHERE id = $1 AND skill_id = $2 AND workspace_id = $3
                  AND archived_at IS NULL`,
              [
                learning.sourceContextId,
                options.skillId,
                options.principal.workspaceId,
              ],
            );
            if (
              lockedContext.rows[0]?.current_knowledge_revision_id !==
              learning.sourceContextRevisionId
            ) {
              throw new DomainError(
                "CONTEXT_REVISION_CONFLICT",
                "The referenced context knowledge changed during amendment",
                409,
              );
            }
          }
          const policy = parseAmendmentPolicy(skillRow.amendment_policy);
          const counts = await countRuleAutoPublications(
            client,
            options.principal.workspaceId,
            options.skillId,
          );
          const policyDecision = evaluateAmendmentPolicy({
            policy,
            principal: options.principal,
            proposedBump,
            sourceContextId: learning.sourceContextId,
            dailyPublicationCounts: counts,
          });
          const autoPublished = policyDecision.outcome === "auto_publish";
          const versionId = id("skill-version");
          const reviewId = id("amendment-review");
          const revision = skillRow.next_revision;
          const semanticVersion = autoPublished
            ? nextSemanticVersion(skillRow.current_semantic_version, proposedBump)
            : null;
          await client.query(
            `UPDATE skills
                SET next_revision = next_revision + 1, updated_at = now()
              WHERE id = $1`,
            [options.skillId],
          );
          await client.query(
            `INSERT INTO skill_versions
               (id, workspace_id, skill_id, revision, semantic_version, status,
                base_version_id, proposed_bump, source, content_digest,
                r2_object_key, bundle_byte_size, manifest, learning_metadata,
                amendment_operations, caller_declaration, policy_decision,
                change_summary, created_by_actor_type, created_by_actor_id,
                created_by_agent, created_by_model, created_for_user_id, published_at)
             VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, 'agent_amendment', $9,
               $10, $11, $12, $13, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23
             )`,
            [
              versionId,
              options.principal.workspaceId,
              options.skillId,
              revision,
              semanticVersion,
              autoPublished ? "published" : "pending_review",
              options.baseVersionId,
              proposedBump,
              canonical.digest,
              storedBundle.key,
              storedBundle.byteSize,
              canonical.manifest,
              learning,
              JSON.stringify(provenanceOperations),
              caller,
              policyDecision,
              learning.summary,
              actor.actorType,
              actor.actorId,
              caller.agent,
              caller.model,
              caller.forUserId,
              autoPublished ? new Date() : null,
            ],
          );
          await client.query(
            `INSERT INTO skill_version_files
               (id, workspace_id, skill_version_id, path, content_type,
                byte_size, sha256, r2_object_key)
             SELECT *
             FROM unnest(
               $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
               $6::bigint[], $7::text[], $8::text[]
             )`,
            [
              canonical.manifest.files.map(() => id("skill-file")),
              canonical.manifest.files.map(() => options.principal.workspaceId),
              canonical.manifest.files.map(() => versionId),
              canonical.manifest.files.map((file) => file.path),
              canonical.manifest.files.map((file) => file.mediaType),
              canonical.manifest.files.map((file) => file.byteSize),
              canonical.manifest.files.map((file) => file.sha256),
              canonical.manifest.files.map(() => storedBundle.key),
            ],
          );
          await client.query(
            `INSERT INTO amendment_reviews
               (id, workspace_id, skill_id, proposed_version_id, status,
                decision_reason, requested_by_actor_type, requested_by_actor_id,
                requested_by_agent, requested_by_model, requested_for_user_id,
                policy_decision, reviewed_by_actor_type, reviewed_by_actor_id,
                reviewed_by_user_id, reviewed_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     $13, $14, $15, $16)`,
            [
              reviewId,
              options.principal.workspaceId,
              options.skillId,
              versionId,
              autoPublished ? "approved" : "pending",
              autoPublished ? "Trusted auto-publish policy matched" : null,
              actor.actorType,
              actor.actorId,
              caller.agent,
              caller.model,
              caller.forUserId,
              policyDecision,
              autoPublished ? actor.actorType : null,
              autoPublished ? actor.actorId : null,
              autoPublished && options.principal.kind === "user"
                ? options.principal.userId
                : null,
              autoPublished ? new Date() : null,
            ],
          );
          if (autoPublished) {
            await client.query(
              `UPDATE skills
                  SET current_published_version_id = $2,
                      published_search_text = $3, updated_at = now()
                WHERE id = $1`,
              [options.skillId, versionId, instructions],
            );
          }
          await insertMutationAudit(client, options.principal, options.auditContext, {
            eventType: "skill.amendment.created",
            action: "skills:amend",
            requestId: options.requestId,
            resourceType: "skill_version",
            resourceId: versionId,
            ...(learning.sourceContextId
              ? { contextId: learning.sourceContextId }
              : {}),
            metadata: {
              skillId: options.skillId,
              baseVersionId: options.baseVersionId,
              revision,
              digest: canonical.digest,
              proposedBump,
              domainCaller: caller,
              policyDecision,
              autoPublished,
            },
          });
          const now = new Date().toISOString();
          const version: SkillVersionRecord = {
            id: versionId,
            workspaceId: options.principal.workspaceId,
            skillId: options.skillId,
            revision,
            semanticVersion,
            status: autoPublished ? "published" : "pending_review",
            baseVersionId: options.baseVersionId,
            proposedBump,
            source: "agent_amendment",
            digest: canonical.digest,
            objectKey: storedBundle.key,
            byteSize: storedBundle.byteSize,
            manifest: canonical.manifest,
            learningMetadata: learning,
            amendmentOperations: provenanceOperations,
            callerDeclaration: caller,
            policyDecision,
            changeSummary: learning.summary,
            createdByActorType: actor.actorType,
            createdByActorId: actor.actorId,
            createdByAgent: caller.agent,
            createdByModel: caller.model,
            createdForUserId: caller.forUserId,
            publishedAt: autoPublished ? now : null,
            createdAt: now,
          };
          const review: AmendmentReviewRecord = {
            id: reviewId,
            workspaceId: options.principal.workspaceId,
            skillId: options.skillId,
            proposedVersionId: versionId,
            status: autoPublished ? "approved" : "pending",
            decisionReason: autoPublished
              ? "Trusted auto-publish policy matched"
              : null,
            policyDecision,
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            requestedByAgent: caller.agent,
            requestedByModel: caller.model,
            requestedForUserId: caller.forUserId,
            reviewedByActorType: autoPublished ? actor.actorType : null,
            reviewedByActorId: autoPublished ? actor.actorId : null,
            reviewedByUserId:
              autoPublished && options.principal.kind === "user"
                ? options.principal.userId
                : null,
            reviewedAt: autoPublished ? now : null,
            createdAt: now,
            updatedAt: now,
          };
          const response: AmendmentResult = {
            review,
            candidate: version,
            policyDecision,
            autoPublished,
          };
          if (autoPublished) {
            const projection = await client.query<{
              id: string;
              workspace_id: string;
              slug: string;
              name: string;
              description: string;
              tags: string[];
              visibility: "private" | "workspace" | "public";
              current_published_version_id: string | null;
              semantic_version: string | null;
              archived_at: Date | null;
              created_at: Date;
              updated_at: Date;
            }>(
              `SELECT skill.id, skill.workspace_id, skill.slug, skill.name,
                      skill.description, skill.tags, skill.visibility,
                      skill.current_published_version_id,
                      current.semantic_version, skill.archived_at,
                      skill.created_at, skill.updated_at
                 FROM skills skill
                 LEFT JOIN skill_versions current
                   ON current.id = skill.current_published_version_id
                WHERE skill.id = $1 AND skill.workspace_id = $2
                LIMIT 1`,
              [options.skillId, options.principal.workspaceId],
            );
            const projected = projection.rows[0];
            if (!projected) {
              throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
            }
            await enqueueCurrentSkillProjection(client, {
              skill: {
                id: projected.id,
                workspaceId: projected.workspace_id,
                slug: projected.slug,
                name: projected.name,
                description: projected.description,
                tags: projected.tags,
                visibility: projected.visibility,
                currentPublishedVersionId: projected.current_published_version_id,
                currentSemanticVersion: projected.semantic_version,
                archivedAt: projected.archived_at?.toISOString() ?? null,
                createdAt: projected.created_at.toISOString(),
                updatedAt: projected.updated_at.toISOString(),
              },
              fencingEpoch: options.fencingEpoch,
            });
          }
          await this.idempotency.complete(client, claim.identity, 201, {
            result: response,
          });
          return response;
        },
        { fencingEpoch: options.fencingEpoch },
      );
      return result;
    } catch (error) {
      await this.idempotency
        .release(claim.identity, options.fencingEpoch)
        .catch(() => undefined);
      if (stored) {
        await this.storage
          .deleteIfUnreferenced(stored.key, async (key) => {
            const result = await this.pool.query(
              "SELECT 1 FROM skill_versions WHERE r2_object_key = $1 LIMIT 1",
              [key],
            );
            return result.rowCount === 1;
          })
          .catch(() => undefined);
      }
      if (error instanceof BundleValidationError) {
        throw new DomainError(error.code, error.message, 400);
      }
      return mapSkillInfrastructureError(error);
    }
  }

  private async validateDeclaredUser(
    workspaceId: string,
    caller: CallerDeclaration,
  ): Promise<void> {
    if (!caller.forUserId) return;
    const result = await this.controlPool.query(
      `SELECT 1
         FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2
        LIMIT 1`,
      [workspaceId, caller.forUserId],
    );
    if (!result.rows[0]) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "caller.forUserId must identify a current workspace member",
        400,
        { field: "caller.forUserId" },
      );
    }
  }

  private async resolveContextSource(options: {
    readonly workspaceId: string;
    readonly skillId: string;
    readonly learning: LearningMetadata;
  }): Promise<{
    readonly revisionId: string | null;
    readonly digest: string | null;
  } | null> {
    if (!options.learning.sourceContextId) {
      if (
        options.learning.sourceContextRevisionId ||
        options.learning.sourceContextDigest
      ) {
        throw new DomainError(
          "LEARNING_METADATA_INVALID",
          "Context revision provenance requires learning.sourceContextId",
          400,
          { field: "learning.sourceContextId" },
        );
      }
      return null;
    }
    const result = await this.pool.query<{
      current_knowledge_revision_id: string | null;
      body_digest: string | null;
    }>(
      `SELECT context.current_knowledge_revision_id, revision.body_digest
         FROM skill_contexts context
         LEFT JOIN context_knowledge_revisions revision
           ON revision.id = context.current_knowledge_revision_id
        WHERE context.id = $1 AND context.skill_id = $2
          AND context.workspace_id = $3 AND context.archived_at IS NULL
        LIMIT 1`,
      [options.learning.sourceContextId, options.skillId, options.workspaceId],
    );
    const context = result.rows[0];
    if (!context) {
      throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
    }
    if (
      options.learning.sourceContextRevisionId &&
      options.learning.sourceContextRevisionId !== context.current_knowledge_revision_id
    ) {
      throw new DomainError(
        "CONTEXT_REVISION_CONFLICT",
        "The declared context revision is no longer current",
        409,
      );
    }
    if (
      options.learning.sourceContextDigest &&
      options.learning.sourceContextDigest !== context.body_digest
    ) {
      throw new DomainError(
        "CONTEXT_REVISION_CONFLICT",
        "The declared context digest is no longer current",
        409,
      );
    }
    return {
      revisionId: context.current_knowledge_revision_id,
      digest: context.body_digest,
    };
  }
}
