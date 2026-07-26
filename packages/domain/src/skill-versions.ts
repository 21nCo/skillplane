import {
  canonicalizeBundle,
  retrieveBundleFile,
  sha256Hex,
  validateBundleArchive,
  type BundleManifest,
  type DownloadedSkillFile,
  type R2BundleRepository,
} from "@skillplane/storage";
import { diffLines } from "diff";
import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest } from "./idempotency.js";
import type { IdempotencyStore } from "./idempotency.js";
import { principalAuditActor, type Principal } from "./principal.js";
import { mapSkillInfrastructureError, type SkillVersionRecord } from "./skills.js";
import { withDomainTransaction as withTransaction } from "./transactions.js";
import { insertPrincipalAudit } from "./mutation-audit.js";

export const SEMANTIC_BUMPS = ["patch", "minor", "major"] as const;
export type SemanticBump = (typeof SEMANTIC_BUMPS)[number];

interface VersionRow {
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
  readonly manifest: BundleManifest;
  readonly learning_metadata?: Readonly<object>;
  readonly amendment_operations?: readonly Readonly<object>[];
  readonly caller_declaration?: Readonly<object>;
  readonly policy_decision?: Readonly<object>;
  readonly change_summary: string;
  readonly created_by_actor_type?: SkillVersionRecord["createdByActorType"];
  readonly created_by_actor_id?: string;
  readonly created_by_agent?: string | null;
  readonly created_by_model?: string | null;
  readonly created_for_user_id?: string | null;
  readonly published_at: Date | null;
  readonly created_at: Date;
  readonly visibility?: string;
  readonly skill_archived_at?: Date | null;
}

export interface SkillFileDiff {
  readonly path: string;
  readonly status: "added" | "removed" | "modified" | "unchanged";
  readonly fromSha256: string | null;
  readonly toSha256: string | null;
  readonly mediaType: string;
  readonly textChanges?: readonly {
    readonly kind: "added" | "removed" | "unchanged";
    readonly value: string;
    readonly lineCount: number;
  }[];
  readonly truncated?: boolean;
}

export interface SkillVersionDiff {
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly files: readonly SkillFileDiff[];
}

export function parseSemanticBump(value: unknown): SemanticBump {
  if (
    typeof value !== "string" ||
    !(SEMANTIC_BUMPS as readonly string[]).includes(value)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Proposed version bump must be patch, minor, or major",
      400,
      { field: "proposedBump" },
    );
  }
  return value as SemanticBump;
}

export function toSkillVersionRecord(row: VersionRow): SkillVersionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    skillId: row.skill_id,
    revision: row.revision,
    semanticVersion: row.semantic_version,
    status: row.status,
    baseVersionId: row.base_version_id,
    proposedBump: row.proposed_bump,
    source: row.source,
    digest: row.content_digest,
    objectKey: row.r2_object_key,
    byteSize: Number(row.bundle_byte_size),
    manifest: row.manifest,
    learningMetadata: row.learning_metadata ?? {},
    amendmentOperations: row.amendment_operations ?? [],
    callerDeclaration: row.caller_declaration ?? {},
    policyDecision: row.policy_decision ?? {},
    changeSummary: row.change_summary,
    createdByActorType: row.created_by_actor_type ?? "system",
    createdByActorId: row.created_by_actor_id ?? "legacy",
    createdByAgent: row.created_by_agent ?? null,
    createdByModel: row.created_by_model ?? null,
    createdForUserId: row.created_for_user_id ?? null,
    publishedAt: row.published_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function normalizeChangeSummary(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", "A change summary is required", 400, {
      field: "changeSummary",
    });
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 2000) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Change summary must be between 1 and 2,000 characters",
      400,
      { field: "changeSummary" },
    );
  }
  return normalized;
}

function mapFileRetrievalError(error: unknown): never {
  if (error instanceof Error && error.message === "SKILL_FILE_NOT_FOUND") {
    throw new DomainError("SKILL_FILE_NOT_FOUND", "Skill file was not found", 404);
  }
  if (error instanceof Error && error.message === "SKILL_FILE_DIGEST_MISMATCH") {
    throw new DomainError(
      "R2_OBJECT_MISMATCH",
      "Stored skill file failed digest verification",
      503,
    );
  }
  return mapSkillInfrastructureError(error);
}

export class SkillVersionService {
  constructor(
    readonly pool: Pool,
    readonly storage: R2BundleRepository,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async createCandidate(options: {
    readonly skillId: string;
    readonly principal: Principal;
    readonly baseVersionId: string;
    readonly proposedBump: SemanticBump;
    readonly changeSummary: string;
    readonly archiveBytes: Uint8Array;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<SkillVersionRecord> {
    authorize(options.principal, "skills:write");
    const proposedBump = parseSemanticBump(options.proposedBump);
    const changeSummary = normalizeChangeSummary(options.changeSummary);
    let canonical;
    try {
      canonical = await canonicalizeBundle(options.archiveBytes);
    } catch (error) {
      return mapSkillInfrastructureError(error);
    }
    const requestHash = await hashIdempotentRequest({
      operation: "skill.version.create",
      skillId: options.skillId,
      baseVersionId: options.baseVersionId,
      proposedBump,
      changeSummary,
      bundleDigest: canonical.digest,
    });
    const claim = await this.idempotency.claim<{ version: SkillVersionRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `skill.version.create:${options.skillId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.version;

    let stored: Awaited<ReturnType<R2BundleRepository["putCanonicalBundle"]>> | null =
      null;
    try {
      const reservedRevision = await withTransaction(
        this.pool,
        `${options.requestId}:reserve`,
        async ({ client }) => {
          const result = await client.query<{
            current_published_version_id: string | null;
            archived_at: Date | null;
            next_revision: number;
            base_digest: string | null;
          }>(
            `SELECT skill.current_published_version_id, skill.archived_at,
                    skill.next_revision, base.content_digest AS base_digest
               FROM skills skill
               LEFT JOIN skill_versions base
                 ON base.id = $3 AND base.skill_id = skill.id
              WHERE skill.id = $1 AND skill.workspace_id = $2
              FOR UPDATE OF skill`,
            [options.skillId, options.principal.workspaceId, options.baseVersionId],
          );
          const row = result.rows[0];
          if (!row) {
            throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
          }
          if (row.archived_at) {
            throw new DomainError(
              "SKILL_ARCHIVED",
              "Archived skills cannot receive new revisions",
              409,
            );
          }
          if (
            row.current_published_version_id !== options.baseVersionId ||
            !row.base_digest
          ) {
            throw new DomainError(
              "SKILL_VERSION_CONFLICT",
              "The base version is no longer current",
              409,
              { currentVersionId: row.current_published_version_id },
            );
          }
          if (row.base_digest === canonical.digest) {
            throw new DomainError(
              "VALIDATION_FAILED",
              "The proposed bundle is identical to its base version",
              400,
            );
          }
          await client.query(
            `UPDATE skills
                SET next_revision = next_revision + 1, updated_at = now()
              WHERE id = $1`,
            [options.skillId],
          );
          return row.next_revision;
        },
      );
      const storedBundle = await this.storage.putCanonicalBundle(
        options.principal.workspaceId,
        options.skillId,
        canonical.digest,
        canonical.bytes,
      );
      stored = storedBundle;
      const versionId = id("skill-version");
      const actor = principalAuditActor(options.principal);
      const source =
        options.principal.kind === "user" ? ("human" as const) : ("import" as const);
      const response = await withTransaction(
        this.pool,
        options.requestId,
        async ({ client }) => {
          await client.query(
            `INSERT INTO skill_versions
               (id, workspace_id, skill_id, revision, semantic_version, status,
                base_version_id, proposed_bump, source, content_digest,
                r2_object_key, bundle_byte_size, manifest, learning_metadata,
                change_summary, created_by_actor_type, created_by_actor_id)
             VALUES (
               $1, $2, $3, $4, NULL, 'pending_review', $5, $6, $7, $8,
               $9, $10, $11, '{}'::jsonb, $12, $13, $14
             )`,
            [
              versionId,
              options.principal.workspaceId,
              options.skillId,
              reservedRevision,
              options.baseVersionId,
              proposedBump,
              source,
              canonical.digest,
              storedBundle.key,
              storedBundle.byteSize,
              canonical.manifest,
              changeSummary,
              actor.actorType,
              actor.actorId,
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
          await insertPrincipalAudit(client, options.principal, {
            eventType: "skill.version.created",
            action: "skills:write",
            requestId: options.requestId,
            resourceType: "skill_version",
            resourceId: versionId,
            skillId: options.skillId,
            versionId,
            metadata: {
              revision: reservedRevision,
              digest: canonical.digest,
              proposedBump,
            },
          });
          const now = new Date().toISOString();
          const version: SkillVersionRecord = {
            id: versionId,
            workspaceId: options.principal.workspaceId,
            skillId: options.skillId,
            revision: reservedRevision,
            semanticVersion: null,
            status: "pending_review",
            baseVersionId: options.baseVersionId,
            proposedBump,
            source,
            digest: canonical.digest,
            objectKey: storedBundle.key,
            byteSize: storedBundle.byteSize,
            manifest: canonical.manifest,
            learningMetadata: {},
            amendmentOperations: [],
            callerDeclaration: {},
            policyDecision: {},
            changeSummary,
            createdByActorType: actor.actorType,
            createdByActorId: actor.actorId,
            createdByAgent: null,
            createdByModel: null,
            createdForUserId: null,
            publishedAt: null,
            createdAt: now,
          };
          await this.idempotency.complete(client, claim.identity, 201, { version });
          return version;
        },
      );
      return response;
    } catch (error) {
      await this.idempotency.release(claim.identity).catch(() => undefined);
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
      return mapSkillInfrastructureError(error);
    }
  }

  async list(options: {
    readonly skillId: string;
    readonly principal?: Principal | null;
    readonly limit?: number;
  }): Promise<readonly SkillVersionRecord[]> {
    if (options.principal) authorize(options.principal, "skills:read");
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const result = await this.pool.query<VersionRow>(
      `SELECT version.id, version.workspace_id, version.skill_id,
              version.revision, version.semantic_version, version.status,
              version.base_version_id, version.proposed_bump, version.source,
              version.content_digest, version.r2_object_key,
              version.bundle_byte_size, version.manifest,
              version.learning_metadata, version.amendment_operations,
              version.caller_declaration, version.policy_decision,
              version.change_summary, version.created_by_actor_type,
              version.created_by_actor_id, version.created_by_agent,
              version.created_by_model, version.created_for_user_id,
              version.published_at, version.created_at
         FROM skill_versions version
         JOIN skills skill ON skill.id = version.skill_id
        WHERE version.skill_id = $1
          AND (
            ($2::text IS NOT NULL AND version.workspace_id = $2)
            OR (
              $2::text IS NULL
              AND skill.visibility = 'public'
              AND skill.archived_at IS NULL
              AND version.status = 'published'
            )
          )
        ORDER BY version.revision DESC, version.id ASC
        LIMIT $3`,
      [options.skillId, options.principal?.workspaceId ?? null, limit],
    );
    if (result.rows.length === 0) {
      const exists = await this.pool.query(
        `SELECT 1
           FROM skills
          WHERE id = $1
            AND (
              ($2::text IS NOT NULL AND workspace_id = $2)
              OR (
                $2::text IS NULL
                AND visibility = 'public'
                AND archived_at IS NULL
                AND current_published_version_id IS NOT NULL
              )
            )`,
        [options.skillId, options.principal?.workspaceId ?? null],
      );
      if (exists.rowCount !== 1) {
        throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
      }
    }
    return result.rows.map(toSkillVersionRecord);
  }

  private async authorizedVersion(options: {
    readonly skillId: string;
    readonly versionId: string;
    readonly principal?: Principal | null;
    readonly allowArchived?: boolean;
  }): Promise<VersionRow> {
    const result = await this.pool.query<VersionRow>(
      `SELECT version.id, version.workspace_id, version.skill_id,
              version.revision, version.semantic_version, version.status,
              version.base_version_id, version.proposed_bump, version.source,
              version.content_digest, version.r2_object_key,
              version.bundle_byte_size, version.manifest,
              version.learning_metadata, version.amendment_operations,
              version.caller_declaration, version.policy_decision,
              version.change_summary, version.created_by_actor_type,
              version.created_by_actor_id, version.created_by_agent,
              version.created_by_model, version.created_for_user_id,
              version.published_at, version.created_at,
              skill.visibility, skill.archived_at AS skill_archived_at
         FROM skill_versions version
         JOIN skills skill ON skill.id = version.skill_id
        WHERE skill.id = $1 AND version.id = $2
          AND (
            ($3::text IS NOT NULL AND skill.workspace_id = $3)
            OR (
              $3::text IS NULL
              AND skill.visibility = 'public'
              AND skill.archived_at IS NULL
              AND version.status = 'published'
            )
          )
          AND ($4::boolean OR skill.archived_at IS NULL)
        LIMIT 1`,
      [
        options.skillId,
        options.versionId,
        options.principal?.workspaceId ?? null,
        options.allowArchived ?? false,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DomainError(
        "SKILL_VERSION_NOT_FOUND",
        "Skill version was not found",
        404,
      );
    }
    if (options.principal) authorize(options.principal, "skills:read");
    return row;
  }

  async get(options: {
    readonly skillId: string;
    readonly versionId: string;
    readonly principal?: Principal | null;
    readonly allowArchived?: boolean;
  }): Promise<SkillVersionRecord> {
    return toSkillVersionRecord(await this.authorizedVersion(options));
  }

  async retrieveBundle(options: {
    readonly skillId: string;
    readonly versionId: string;
    readonly principal?: Principal | null;
    readonly allowArchived?: boolean;
  }): Promise<{
    readonly bytes: Uint8Array;
    readonly digest: `sha256:${string}`;
  }> {
    const version = await this.authorizedVersion(options);
    try {
      const bundle = await this.storage.getCanonicalBundle(
        version.r2_object_key,
        version.content_digest,
      );
      return { bytes: bundle.bytes, digest: version.content_digest };
    } catch (error) {
      return mapSkillInfrastructureError(error);
    }
  }

  async retrieveFile(options: {
    readonly skillId: string;
    readonly versionId: string;
    readonly path: string;
    readonly principal?: Principal | null;
    readonly allowArchived?: boolean;
  }): Promise<{
    readonly file: DownloadedSkillFile;
    readonly publicImmutable: boolean;
  }> {
    const version = await this.authorizedVersion(options);
    const fileRow = await this.pool.query<{ sha256: string }>(
      `SELECT sha256
         FROM skill_version_files
        WHERE workspace_id = $1 AND skill_version_id = $2 AND path = $3`,
      [version.workspace_id, version.id, options.path],
    );
    const expected = fileRow.rows[0]?.sha256;
    try {
      const file = await retrieveBundleFile({
        repository: this.storage,
        objectKey: version.r2_object_key,
        bundleDigest: version.content_digest,
        path: options.path,
        ...(expected ? { expectedFileDigest: expected } : {}),
      });
      return {
        file,
        publicImmutable:
          version.visibility === "public" &&
          version.status === "published" &&
          !version.skill_archived_at,
      };
    } catch (error) {
      return mapFileRetrievalError(error);
    }
  }

  async diff(options: {
    readonly skillId: string;
    readonly fromVersionId: string;
    readonly toVersionId: string;
    readonly principal: Principal;
  }): Promise<SkillVersionDiff> {
    authorize(options.principal, "skills:read");
    const [from, to] = await Promise.all([
      this.authorizedVersion({
        skillId: options.skillId,
        versionId: options.fromVersionId,
        principal: options.principal,
        allowArchived: true,
      }),
      this.authorizedVersion({
        skillId: options.skillId,
        versionId: options.toVersionId,
        principal: options.principal,
        allowArchived: true,
      }),
    ]);
    const [fromBundle, toBundle] = await Promise.all([
      this.storage.getCanonicalBundle(from.r2_object_key, from.content_digest),
      this.storage.getCanonicalBundle(to.r2_object_key, to.content_digest),
    ]);
    const [fromValidated, toValidated] = await Promise.all([
      validateBundleArchive(fromBundle.bytes),
      validateBundleArchive(toBundle.bytes),
    ]);
    const paths = [
      ...new Set([...fromValidated.files.keys(), ...toValidated.files.keys()]),
    ].sort();
    const files: SkillFileDiff[] = [];
    for (const path of paths) {
      const before = fromValidated.files.get(path);
      const after = toValidated.files.get(path);
      const beforeManifest =
        from.manifest.files.find((file) => file.path === path) ??
        (path === "skill.json"
          ? {
              sha256: before ? await sha256Hex(before) : "",
              mediaType: "application/json",
            }
          : undefined);
      const afterManifest =
        to.manifest.files.find((file) => file.path === path) ??
        (path === "skill.json"
          ? {
              sha256: after ? await sha256Hex(after) : "",
              mediaType: "application/json",
            }
          : undefined);
      const status = !before
        ? "added"
        : !after
          ? "removed"
          : beforeManifest?.sha256 === afterManifest?.sha256
            ? "unchanged"
            : "modified";
      const mediaType =
        afterManifest?.mediaType ??
        beforeManifest?.mediaType ??
        "application/octet-stream";
      const diff: SkillFileDiff = {
        path,
        status,
        fromSha256: beforeManifest?.sha256 ?? null,
        toSha256: afterManifest?.sha256 ?? null,
        mediaType,
      };
      if (
        status === "modified" &&
        before &&
        after &&
        (mediaType.startsWith("text/") ||
          mediaType === "application/json" ||
          mediaType === "application/yaml") &&
        before.byteLength + after.byteLength <= 2 * 1024 * 1024
      ) {
        const oldText = new TextDecoder("utf-8", { fatal: true }).decode(before);
        const newText = new TextDecoder("utf-8", { fatal: true }).decode(after);
        const changes = diffLines(oldText, newText, { timeout: 1000 });
        const textChanges = changes?.map((change) => ({
          kind: change.added
            ? ("added" as const)
            : change.removed
              ? ("removed" as const)
              : ("unchanged" as const),
          value: change.value,
          lineCount: change.count,
        }));
        const totalLength =
          textChanges?.reduce((total, change) => total + change.value.length, 0) ?? 0;
        if (textChanges && totalLength <= 200_000) {
          files.push({ ...diff, textChanges });
          continue;
        }
        files.push({ ...diff, truncated: true });
        continue;
      }
      files.push(diff);
    }
    return {
      fromVersionId: from.id,
      toVersionId: to.id,
      files,
    };
  }
}
