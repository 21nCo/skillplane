import type { Pool, PoolClient } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import type { Principal } from "./principal.js";
import { hashIdempotentRequest, validateIdempotencyKey } from "./idempotency.js";
import { withDomainTransaction } from "./transactions.js";
import { insertPrincipalAudit } from "./mutation-audit.js";
import type { SkillService } from "./skills.js";
import type { SkillVersionService } from "./skill-versions.js";
import {
  gitSourceConfig,
  PublicGitHubSourceProvider,
  type GitSourceConfig,
  type GitSourceProvider,
} from "./git-source-provider.js";
interface Mutation {
  principal: Principal;
  requestId: string;
  fencingEpoch?: number;
}
interface SourceRow {
  id: string;
  workspace_id: string;
  repository_url: string;
  ref: string;
  ref_policy: "track" | "pin";
  skill_path: string | null;
  revision: number;
  archived_at: Date | null;
  creation_hash: string;
  sync_token: string | null;
  sync_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface GitSource {
  id: string;
  workspaceId: string;
  repositoryUrl: string;
  ref: string;
  refPolicy: "track" | "pin";
  path: string | null;
  revision: number;
  archivedAt: string | null;
  updatedAt: string;
}
function record(r: SourceRow): GitSource {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    repositoryUrl: r.repository_url,
    ref: r.ref,
    refPolicy: r.ref_policy,
    path: r.skill_path,
    revision: r.revision,
    archivedAt: r.archived_at?.toISOString() ?? null,
    updatedAt: r.updated_at.toISOString(),
  };
}
interface Binding {
  skill_path: string;
  skill_id: string;
  last_commit_sha: string | null;
  last_digest: string | null;
  last_version_id: string | null;
  base_version_id: string | null;
  status: string;
  current_published_version_id: string | null;
  archived_at: Date | null;
  slug: string;
  name: string;
  current_digest: string | null;
  disconnected_at: Date | null;
}
export interface GitPlanEntry {
  path: string;
  slug: string | null;
  digest: string | null;
  action: "added" | "changed" | "unchanged" | "missing" | "conflict" | "error";
  skillId: string | null;
  baseVersionId: string | null;
  bindingVersionId: string | null;
  message: string | null;
}
export interface GitApplyResult {
  path: string;
  status: string;
  skillId: string | null;
  versionId: string | null;
  message: string | null;
}
interface RunRow {
  id: string;
  workspace_id: string;
  source_id: string;
  source_revision: number;
  failure_message: string | null;
  commit_sha: string;
  plan: GitPlanEntry[];
  results: GitApplyResult[];
  status: "preview" | "partial" | "complete";
  created_at: Date;
  applied_at: Date | null;
}
function runRecord(r: RunRow) {
  return {
    id: r.id,
    commitSha: r.commit_sha,
    plan: r.plan,
    results: r.results,
    status: r.status,
    failureMessage: r.failure_message,
    createdAt: r.created_at.toISOString(),
    appliedAt: r.applied_at?.toISOString() ?? null,
  };
}
export class GitSourceService {
  constructor(
    private readonly pool: Pool,
    private readonly skills: SkillService,
    private readonly versions: SkillVersionService,
    private readonly provider: GitSourceProvider = new PublicGitHubSourceProvider(),
  ) {}
  private transaction<T>(m: Mutation, fn: (client: PoolClient) => Promise<T>) {
    return withDomainTransaction(this.pool, m.requestId, ({ client }) => fn(client), {
      fencingEpoch: m.fencingEpoch,
    });
  }
  private async audit(
    c: PoolClient,
    m: Mutation,
    id: string,
    event: string,
    metadata: Record<string, unknown> = {},
  ) {
    await insertPrincipalAudit(c, m.principal, {
      eventType: `skill_source.${event}`,
      action: "workspace:update",
      requestId: m.requestId,
      resourceType: "skill_source",
      resourceId: id,
      metadata,
    });
  }
  private async row(
    p: Principal,
    id: string,
    c: Pool | PoolClient = this.pool,
    lock = false,
  ) {
    authorize(p, "skills:read");
    const r = await c.query<SourceRow>(
      `SELECT * FROM skill_sources WHERE workspace_id=$1 AND id=$2 ${lock ? "FOR UPDATE" : ""}`,
      [p.workspaceId, id],
    );
    if (!r.rows[0]) throw new DomainError("NOT_FOUND", "Source was not found", 404);
    return r.rows[0];
  }
  async list(p: Principal, cursor: string | null = null) {
    authorize(p, "skills:read");
    if (cursor && cursor.length > 200)
      throw new DomainError("VALIDATION_FAILED", "Invalid source cursor", 400);
    const r = await this.pool.query<SourceRow>(
      "SELECT * FROM skill_sources WHERE workspace_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT 51",
      [p.workspaceId, cursor],
    );
    return {
      sources: r.rows.slice(0, 50).map(record),
      nextCursor: r.rows.length > 50 ? (r.rows[49]?.id ?? null) : null,
    };
  }
  async get(p: Principal, id: string) {
    const source = record(await this.row(p, id));
    const bindings = await this.bindings(p, id, true);
    const runs = await this.pool.query<RunRow>(
      "SELECT * FROM skill_source_runs WHERE workspace_id=$1 AND source_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20",
      [p.workspaceId, id],
    );
    return {
      source,
      bindings: bindings.map((b) => ({
        path: b.skill_path,
        skillId: b.skill_id,
        slug: b.slug,
        name: b.name,
        status: b.status,
        disconnectedAt: b.disconnected_at?.toISOString() ?? null,
        lastCommitSha: b.last_commit_sha,
        lastDigest: b.last_digest,
        lastVersionId: b.last_version_id,
      })),
      runs: runs.rows.map(runRecord),
    };
  }
  async create(
    m: Mutation & { config: Record<string, unknown>; idempotencyKey: string },
  ) {
    authorize(m.principal, "workspace:update");
    const config = gitSourceConfig(m.config),
      key = validateIdempotencyKey(m.idempotencyKey),
      hash = await hashIdempotentRequest(config),
      id = `source:${await hashIdempotentRequest({ workspace: m.principal.workspaceId, actor: m.principal.actorId, key })}`;
    return this.transaction(m, async (c) => {
      const r = await c.query<SourceRow>(
        "INSERT INTO skill_sources(id,workspace_id,repository_url,ref,ref_policy,skill_path,creation_hash) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET id=skill_sources.id RETURNING *",
        [
          id,
          m.principal.workspaceId,
          config.repositoryUrl,
          config.ref,
          config.refPolicy,
          config.path,
          hash,
        ],
      );
      const row = r.rows[0];
      if (!row) throw new DomainError("CONFLICT", "Source creation failed", 409);
      if (row.creation_hash !== hash)
        throw new DomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "Creation key was already used",
          409,
        );
      // A creation audit has a deterministic resource ID; only emit once.
      const prior = await c.query(
        "SELECT 1 FROM audit_events WHERE workspace_id=$1 AND resource_id=$2 AND event_type='skill_source.created'",
        [m.principal.workspaceId, id],
      );
      if (!prior.rowCount) await this.audit(c, m, id, "created");
      return record(row);
    });
  }
  async update(
    m: Mutation & {
      sourceId: string;
      expectedRevision: number;
      config: Record<string, unknown>;
      archived: boolean;
    },
  ) {
    authorize(m.principal, "workspace:update");
    const config = gitSourceConfig(m.config);
    if (!Number.isSafeInteger(m.expectedRevision) || typeof m.archived !== "boolean")
      throw new DomainError(
        "VALIDATION_FAILED",
        "Revision and archived state are required",
        400,
      );
    return this.transaction(m, async (c) => {
      const row = await this.row(m.principal, m.sourceId, c, true);
      if (
        row.revision !== m.expectedRevision ||
        (row.sync_expires_at && row.sync_expires_at > new Date())
      )
        throw new DomainError(
          "CONFLICT",
          "Source changed or sync is running; reload first",
          409,
        );
      if (config.repositoryUrl !== row.repository_url || config.path !== row.skill_path)
        throw new DomainError(
          "CONFLICT",
          "Create a new source to change repository or path scope",
          409,
        );
      const r = await c.query<SourceRow>(
        "UPDATE skill_sources SET ref=$3,ref_policy=$4,archived_at=CASE WHEN $5::boolean THEN COALESCE(archived_at,now()) ELSE NULL END,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *",
        [m.principal.workspaceId, m.sourceId, config.ref, config.refPolicy, m.archived],
      );
      await this.audit(c, m, row.id, "updated", { archived: m.archived });
      const updated = r.rows[0];
      if (!updated) throw new DomainError("NOT_FOUND", "Source was not found", 404);
      return record(updated);
    });
  }
  private async bindings(p: Principal, id: string, includeDisconnected = false) {
    return (
      await this.pool.query<Binding>(
        "SELECT b.*,s.slug,s.name,s.current_published_version_id,s.archived_at,v.content_digest AS current_digest FROM skill_source_bindings b JOIN skills s ON s.workspace_id=b.workspace_id AND s.id=b.skill_id LEFT JOIN skill_versions v ON v.workspace_id=s.workspace_id AND v.id=s.current_published_version_id WHERE b.workspace_id=$1 AND b.source_id=$2 AND ($3::boolean OR b.disconnected_at IS NULL) ORDER BY b.skill_path",
        [p.workspaceId, id, includeDisconnected],
      )
    ).rows;
  }
  async bind(m: Mutation & { sourceId: string; path: string; skillId: string }) {
    authorize(m.principal, "workspace:update");
    gitSourceConfig({ repositoryUrl: "https://github.com/owner/repo", path: m.path });
    return this.transaction(m, async (c) => {
      const s = await this.row(m.principal, m.sourceId, c, true);
      if (s.archived_at || (s.sync_expires_at && s.sync_expires_at > new Date()))
        throw new DomainError("CONFLICT", "Source is archived or syncing", 409);
      if (s.skill_path !== null && s.skill_path !== m.path)
        throw new DomainError(
          "VALIDATION_FAILED",
          "Path does not match this single-skill source",
          400,
        );
      const skill = await c.query<{ current_published_version_id: string }>(
        "SELECT current_published_version_id FROM skills WHERE workspace_id=$1 AND id=$2 AND archived_at IS NULL FOR SHARE",
        [m.principal.workspaceId, m.skillId],
      );
      if (!skill.rows[0])
        throw new DomainError("NOT_FOUND", "Workspace skill was not found", 404);
      const old = await c.query<{ skill_id: string }>(
        "SELECT skill_id FROM skill_source_bindings WHERE workspace_id=$1 AND source_id=$2 AND skill_path=$3 AND disconnected_at IS NULL",
        [m.principal.workspaceId, m.sourceId, m.path],
      );
      if (old.rows[0]) {
        if (old.rows[0].skill_id !== m.skillId)
          throw new DomainError("CONFLICT", "Source path is already bound", 409);
        return { changed: false };
      }
      const count = await c.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM skill_source_bindings WHERE workspace_id=$1 AND source_id=$2 AND disconnected_at IS NULL",
        [m.principal.workspaceId, m.sourceId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= 32)
        throw new DomainError(
          "VALIDATION_FAILED",
          "A source may bind at most 32 skills",
          400,
        );
      try {
        await c.query(
          "INSERT INTO skill_source_bindings(workspace_id,source_id,skill_path,skill_id,base_version_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id,skill_path) DO UPDATE SET skill_id=EXCLUDED.skill_id,base_version_id=EXCLUDED.base_version_id,last_digest=NULL,last_version_id=NULL,last_commit_sha=NULL,disconnected_at=NULL,status='bound',updated_at=now()",
          [
            m.principal.workspaceId,
            m.sourceId,
            m.path,
            m.skillId,
            skill.rows[0].current_published_version_id,
          ],
        );
      } catch (e) {
        if (typeof e === "object" && e !== null && "code" in e && e.code === "23505")
          throw new DomainError("CONFLICT", "Skill is already bound to a source", 409);
        throw e;
      }
      await c.query(
        "UPDATE skill_sources SET revision=revision+1,updated_at=now() WHERE id=$1",
        [s.id],
      );
      await this.audit(c, m, s.id, "bound", { skillId: m.skillId, path: m.path });
      return { changed: true };
    });
  }
  async disconnect(m: Mutation & { sourceId: string; path: string }) {
    authorize(m.principal, "workspace:update");
    return this.transaction(m, async (c) => {
      const source = await this.row(m.principal, m.sourceId, c, true);
      if (source.sync_expires_at && source.sync_expires_at > new Date())
        throw new DomainError("CONFLICT", "Source is syncing", 409);
      const r = await c.query(
        "UPDATE skill_source_bindings SET disconnected_at=now(),status='disconnected',updated_at=now() WHERE workspace_id=$1 AND source_id=$2 AND skill_path=$3 AND disconnected_at IS NULL RETURNING skill_id",
        [m.principal.workspaceId, m.sourceId, m.path],
      );
      if (r.rowCount) {
        await c.query(
          "UPDATE skill_sources SET revision=revision+1,updated_at=now() WHERE id=$1",
          [m.sourceId],
        );
        await this.audit(c, m, m.sourceId, "disconnected", { path: m.path });
      }
      return { changed: Boolean(r.rowCount) };
    });
  }
  async preview(m: Mutation & { sourceId: string }) {
    authorize(m.principal, "workspace:update");
    const source = record(await this.row(m.principal, m.sourceId));
    if (source.archivedAt)
      throw new DomainError("CONFLICT", "Restore the source before syncing", 409);
    const snapshot = await this.provider.snapshot(this.config(source)),
      bindings = await this.bindings(m.principal, source.id);
    const catalog = await this.pool.query<{ slug: string; id: string }>(
      "SELECT slug,id FROM skills WHERE workspace_id=$1",
      [m.principal.workspaceId],
    );
    const plan: GitPlanEntry[] = [];
    const seen = new Set<string>(),
      slugs = new Set<string>();
    for (const item of snapshot.skills) {
      seen.add(item.path);
      const binding = bindings.find((b) => b.skill_path === item.path),
        base = {
          path: item.path,
          slug: item.bundle?.skill.slug ?? null,
          digest: item.bundle?.digest ?? null,
          skillId: binding?.skill_id ?? null,
          baseVersionId: binding?.current_published_version_id ?? null,
          bindingVersionId: binding?.last_version_id ?? null,
        };
      if (!item.bundle) {
        plan.push({ ...base, action: "error", message: item.error ?? "Invalid skill" });
        continue;
      }
      const slug = item.bundle.skill.slug,
        collision = slugs.has(slug);
      slugs.add(slug);
      if (
        collision ||
        (!binding && catalog.rows.some((s) => s.slug === slug)) ||
        (binding &&
          (binding.slug !== slug ||
            binding.archived_at ||
            (binding.current_published_version_id !== binding.base_version_id &&
              binding.current_published_version_id !== binding.last_version_id)))
      ) {
        plan.push({
          ...base,
          action: "conflict",
          message:
            "Slug conflict, archived skill, or manual changes require explicit resolution",
        });
        continue;
      }
      // If a pending imported version was rejected, do not silently call it synced.
      const last = binding?.last_version_id
        ? await this.pool.query<{ status: string }>(
            "SELECT status FROM skill_versions WHERE workspace_id=$1 AND id=$2",
            [m.principal.workspaceId, binding.last_version_id],
          )
        : null;
      if (
        binding?.last_digest === item.bundle.digest &&
        last?.rows[0]?.status === "rejected"
      ) {
        plan.push({
          ...base,
          action: "conflict",
          message: "The last imported candidate was rejected",
        });
        continue;
      }
      plan.push({
        ...base,
        action: binding
          ? binding.last_digest === item.bundle.digest ||
            binding.current_digest === item.bundle.digest
            ? "unchanged"
            : "changed"
          : "added",
        message: null,
      });
    }
    for (const binding of bindings)
      if (!seen.has(binding.skill_path))
        plan.push({
          path: binding.skill_path,
          slug: binding.slug,
          digest: binding.last_digest,
          skillId: binding.skill_id,
          baseVersionId: binding.current_published_version_id,
          bindingVersionId: binding.last_version_id,
          action: "missing",
          message: "Source path is missing or renamed; the existing skill is preserved",
        });
    return this.transaction(m, async (c) => {
      const current = await this.row(m.principal, source.id, c, true);
      if (
        current.revision !== source.revision ||
        current.archived_at ||
        (current.sync_expires_at && current.sync_expires_at > new Date())
      )
        throw new DomainError(
          "CONFLICT",
          "Source changed during preview; preview again",
          409,
        );
      const id = `source-run:${crypto.randomUUID()}`;
      const r = await c.query<RunRow>(
        "INSERT INTO skill_source_runs(id,workspace_id,source_id,source_revision,commit_sha,plan) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          id,
          m.principal.workspaceId,
          source.id,
          source.revision,
          snapshot.commitSha,
          JSON.stringify(plan),
        ],
      );
      await this.audit(c, m, source.id, "previewed", {
        runId: id,
        commitSha: snapshot.commitSha,
      });
      const row = r.rows[0];
      if (!row) throw new DomainError("CONFLICT", "Preview could not be saved", 409);
      return runRecord(row);
    });
  }
  private config(s: GitSource): GitSourceConfig {
    return {
      repositoryUrl: s.repositoryUrl,
      ref: s.ref,
      refPolicy: s.refPolicy,
      path: s.path,
    };
  }
  async apply(m: Mutation & { sourceId: string; runId: string }) {
    authorize(m.principal, "workspace:update");
    const token = crypto.randomUUID();
    const claimed = await this.transaction(m, async (c) => {
      const source = await this.row(m.principal, m.sourceId, c, true),
        r = await c.query<RunRow>(
          "SELECT * FROM skill_source_runs WHERE workspace_id=$1 AND source_id=$2 AND id=$3 FOR UPDATE",
          [m.principal.workspaceId, m.sourceId, m.runId],
        ),
        run = r.rows[0];
      if (!run) throw new DomainError("NOT_FOUND", "Preview was not found", 404);
      if (run.status === "complete")
        return { source: record(source), run, replay: true };
      if (
        source.archived_at ||
        source.revision !== run.source_revision ||
        (source.sync_expires_at && source.sync_expires_at > new Date())
      )
        throw new DomainError(
          "CONFLICT",
          "Source changed, is archived, or another sync is running",
          409,
        );
      await c.query(
        "UPDATE skill_sources SET sync_token=$3,sync_expires_at=now()+interval '3 minutes' WHERE workspace_id=$1 AND id=$2",
        [m.principal.workspaceId, source.id, token],
      );
      return { source: record(source), run, replay: false };
    });
    if (claimed.replay) return runRecord(claimed.run);
    const { source, run } = claimed,
      results = [...run.results];
    try {
      const snapshot = await this.provider.snapshot(
        this.config(source),
        run.commit_sha,
      );
      if (snapshot.commitSha !== run.commit_sha)
        throw new DomainError("CONFLICT", "Preview commit changed", 409);
      for (const entry of run.plan) {
        if (results.some((r) => r.path === entry.path && !["error"].includes(r.status)))
          continue;
        await this.transaction(m, async (c) => {
          const renewed = await c.query(
            "UPDATE skill_sources SET sync_expires_at=now()+interval '3 minutes' WHERE workspace_id=$1 AND id=$2 AND sync_token=$3 AND sync_expires_at>now() RETURNING id",
            [m.principal.workspaceId, source.id, token],
          );
          if (!renewed.rowCount)
            throw new DomainError(
              "CONFLICT",
              "Sync lease expired; retry the preview",
              409,
            );
        });
        let result: GitApplyResult = {
          path: entry.path,
          status: entry.action === "error" ? "invalid" : entry.action,
          skillId: entry.skillId,
          versionId: null,
          message: entry.message,
        };
        try {
          const bundle = snapshot.skills.find((s) => s.path === entry.path)?.bundle;
          if (
            ["added", "changed", "unchanged"].includes(entry.action) &&
            bundle?.digest !== entry.digest
          )
            throw new DomainError(
              "CONFLICT",
              "Preview content changed; preview again",
              409,
            );
          if ((entry.action === "added" || entry.action === "changed") && bundle) {
            const recovered = await this.pool.query<{
              version_id: string;
              skill_id: string;
              status: string;
            }>(
              "SELECT p.version_id,v.skill_id,v.status FROM skill_version_git_provenance p JOIN skill_versions v ON v.id=p.version_id AND v.workspace_id=p.workspace_id WHERE p.workspace_id=$1 AND p.run_id=$2 AND p.skill_path=$3",
              [m.principal.workspaceId, run.id, entry.path],
            );
            let versionId: string, skillId: string;
            if (recovered.rows[0]) {
              versionId = recovered.rows[0].version_id;
              skillId = recovered.rows[0].skill_id;
            } else {
              if (entry.action === "changed") {
                const binding = (await this.bindings(m.principal, source.id)).find(
                  (b) => b.skill_path === entry.path,
                );
                if (
                  binding?.last_version_id !== entry.bindingVersionId ||
                  binding.current_published_version_id !== entry.baseVersionId
                )
                  throw new DomainError(
                    "CONFLICT",
                    "Skill or binding changed after preview; preview again",
                    409,
                  );
              }
              const options = {
                principal: m.principal,
                archiveBytes: bundle.bytes,
                idempotencyKey: `git:${await hashIdempotentRequest({ run: run.id, path: entry.path })}`,
                requestId: m.requestId,
                ...(m.fencingEpoch === undefined
                  ? {}
                  : { fencingEpoch: m.fencingEpoch }),
                gitProvenance: {
                  sourceId: source.id,
                  runId: run.id,
                  repositoryUrl: source.repositoryUrl,
                  commitSha: run.commit_sha,
                  path: entry.path,
                },
              };
              if (entry.action === "added") {
                const created = await this.skills.create({
                  ...options,
                  workspaceId: m.principal.workspaceId,
                  visibility: "private",
                });
                skillId = created.skill.id;
                versionId = created.version.id;
              } else {
                if (!entry.skillId || !entry.baseVersionId)
                  throw new DomainError(
                    "CONFLICT",
                    "Binding lacks a published base",
                    409,
                  );
                const version = await this.versions.createCandidate({
                  ...options,
                  skillId: entry.skillId,
                  baseVersionId: entry.baseVersionId,
                  proposedBump: "patch",
                  changeSummary: `Import ${source.repositoryUrl} at ${run.commit_sha}`,
                });
                skillId = entry.skillId;
                versionId = version.id;
              }
            }
            result = {
              ...result,
              status: entry.action === "added" ? "imported" : "pending_review",
              skillId,
              versionId,
              message: null,
            };
            await this.transaction(m, async (c) => {
              await c.query(
                "INSERT INTO skill_source_bindings(workspace_id,source_id,skill_path,skill_id,last_commit_sha,last_digest,last_version_id,base_version_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(source_id,skill_path) DO UPDATE SET skill_id=EXCLUDED.skill_id,disconnected_at=NULL,last_commit_sha=EXCLUDED.last_commit_sha,last_digest=EXCLUDED.last_digest,last_version_id=EXCLUDED.last_version_id,base_version_id=EXCLUDED.base_version_id,status=EXCLUDED.status,updated_at=now()",
                [
                  m.principal.workspaceId,
                  source.id,
                  entry.path,
                  skillId,
                  run.commit_sha,
                  entry.digest,
                  versionId,
                  entry.baseVersionId ?? versionId,
                  result.status,
                ],
              );
            });
          } else if (entry.skillId)
            await this.transaction(m, async (c) => {
              await c.query(
                "UPDATE skill_source_bindings SET status=$4,last_commit_sha=CASE WHEN $4='unchanged' THEN $5 ELSE last_commit_sha END,updated_at=now() WHERE workspace_id=$1 AND source_id=$2 AND skill_path=$3",
                [
                  m.principal.workspaceId,
                  source.id,
                  entry.path,
                  entry.action,
                  run.commit_sha,
                ],
              );
            });
        } catch (e) {
          result = {
            ...result,
            status: "error",
            message:
              e instanceof DomainError
                ? e.message
                : "Import failed; retry this preview",
          };
        }
        const previous = results.findIndex((r) => r.path === entry.path);
        if (previous >= 0) results[previous] = result;
        else results.push(result);
        await this.transaction(m, async (c) => {
          await c.query(
            "UPDATE skill_source_runs SET results=$4,status='partial',failure_message=NULL,applied_at=now() WHERE workspace_id=$1 AND source_id=$2 AND id=$3",
            [m.principal.workspaceId, source.id, run.id, JSON.stringify(results)],
          );
        });
      }
      const status = results.some((r) => r.status === "error") ? "partial" : "complete";
      await this.transaction(m, async (c) => {
        await c.query(
          "UPDATE skill_source_runs SET results=$4,status=$5,failure_message=NULL,applied_at=now() WHERE workspace_id=$1 AND source_id=$2 AND id=$3",
          [m.principal.workspaceId, source.id, run.id, JSON.stringify(results), status],
        );
        if (status === "complete")
          await c.query(
            "UPDATE skill_sources SET revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND sync_token=$3",
            [m.principal.workspaceId, source.id, token],
          );
        await this.audit(c, m, source.id, "synced", {
          runId: run.id,
          commitSha: run.commit_sha,
          status,
        });
      });
      return runRecord({
        ...run,
        results,
        status,
        failure_message: null,
        applied_at: new Date(),
      });
    } catch (error) {
      await this.transaction(m, async (c) => {
        await c.query(
          "UPDATE skill_source_runs SET status='partial',failure_message=$4,applied_at=now() WHERE workspace_id=$1 AND source_id=$2 AND id=$3",
          [
            m.principal.workspaceId,
            source.id,
            run.id,
            "Source sync could not complete; retry this preview",
          ],
        );
      }).catch(() => undefined);
      throw error;
    } finally {
      await this.transaction(m, async (c) => {
        await c.query(
          "UPDATE skill_sources SET sync_token=NULL,sync_expires_at=NULL WHERE workspace_id=$1 AND id=$2 AND sync_token=$3",
          [m.principal.workspaceId, source.id, token],
        );
      }).catch(() => undefined);
    }
  }
  async provenance(p: Principal, versionId: string) {
    authorize(p, "skills:read");
    return (
      (
        await this.pool.query<{
          repository_url: string;
          commit_sha: string;
          skill_path: string;
          bundle_digest: string;
          imported_at: Date;
          source_id: string;
        }>(
          "SELECT * FROM skill_version_git_provenance WHERE workspace_id=$1 AND version_id=$2",
          [p.workspaceId, versionId],
        )
      ).rows[0] ?? null
    );
  }
}
