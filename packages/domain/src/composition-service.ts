import {
  canonicalizeBundle,
  canonicalizeBundleFiles,
  stableJson,
  verificationClaimsSchema,
  type CanonicalBundle,
  type R2BundleRepository,
  type SkillDependency,
} from "@skillplane/storage";
import type { Pool, PoolClient } from "pg";
import { satisfies, valid } from "semver";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import type { Principal } from "./principal.js";
import {
  COMPOSITION_LIMITS,
  compositionDigest,
  emptyLock,
  resolveDependencies,
  validateLock,
  type CompositionPlan,
  type DependencyChoice,
  type DependencyLock,
  type DependencyNode,
  type ResolvedModule,
} from "./composition.js";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
interface Source {
  id: string;
  workspace_id: string;
  skill_id: string;
  workspace_slug: string;
  skill_slug: string;
  semantic_version: string;
  content_digest: `sha256:${string}`;
  r2_object_key: string;
  visibility: string;
  archived_at: Date | null;
  status: string;
  deprecated_at: Date | null;
  revoked_at: Date | null;
  bundle: CanonicalBundle;
  publicSource: boolean;
}
export interface PreparedComposition {
  bundle: CanonicalBundle;
  lock: DependencyLock;
  closureDigest: string;
}

export class CompositionService {
  constructor(
    readonly pool: Pool,
    readonly storage: R2BundleRepository,
    readonly controlPool: Pool = pool,
    readonly publicStorage: R2BundleRepository = storage,
    readonly publicOnly = false,
    readonly writesEnabled = true,
  ) {}

  private denied(): never {
    throw new DomainError(
      "SKILL_DEPENDENCY_CONFLICT",
      "Dependency is unavailable or inaccessible",
      409,
    );
  }
  private async workspaceSlug(workspaceId: string): Promise<string> {
    const result = await this.controlPool.query<{ slug: string }>(
      "SELECT slug FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    if (!result.rows[0]) this.denied();
    return result.rows[0].slug;
  }
  async assertAvailable(
    versionId: string,
  ): Promise<{ deprecated_at: Date | null; withdrawn_sequence: string | null }> {
    const result = await this.controlPool.query<{
      deprecated_at: Date | null;
      revoked_at: Date | null;
      withdrawn_sequence: string | null;
    }>(
      "SELECT deprecated_at,revoked_at,withdrawn_sequence FROM public_skill_version_lifecycle WHERE version_id=$1",
      [versionId],
    );
    if (result.rows[0]?.revoked_at)
      throw new DomainError(
        "SKILL_VERSION_REVOKED",
        "A required version was revoked",
        409,
      );
    return {
      deprecated_at: result.rows[0]?.deprecated_at ?? null,
      withdrawn_sequence: result.rows[0]?.withdrawn_sequence ?? null,
    };
  }
  private async source(
    versionId: string,
    principal: Principal | null,
    db: Queryable = this.pool,
  ): Promise<Source> {
    const globalLifecycle = await this.assertAvailable(versionId);
    const result = this.publicOnly
      ? { rows: [] }
      : await db.query<Omit<Source, "bundle" | "workspace_slug" | "publicSource">>(
          `SELECT v.id, v.workspace_id, v.skill_id, s.slug AS skill_slug,
              v.semantic_version, v.content_digest, v.r2_object_key, s.visibility, s.archived_at, v.status,
              lifecycle.deprecated_at, lifecycle.revoked_at
         FROM skill_versions v JOIN skills s ON s.id = v.skill_id
         LEFT JOIN skill_version_lifecycle lifecycle ON lifecycle.version_id = v.id
        WHERE v.id = $1`,
          [versionId],
        );
    const row = result.rows[0];
    if (row) {
      if (row.revoked_at)
        throw new DomainError(
          "SKILL_VERSION_REVOKED",
          "A required version was revoked",
          409,
        );
      if (
        row.workspace_id !== principal?.workspaceId &&
        (row.visibility !== "public" || row.archived_at)
      )
        this.denied();
      const stored = await this.storage.getCanonicalBundle(
        row.r2_object_key,
        row.content_digest,
      );
      return {
        ...row,
        workspace_slug: await this.workspaceSlug(row.workspace_id),
        bundle: await canonicalizeBundle(stored.bytes),
        publicSource: false,
      };
    }
    const projection = await this.controlPool.query<{
      version_id: string;
      workspace_id: string;
      workspace_slug: string;
      skill_id: string;
      skill_slug: string;
      semantic_version: string;
      digest: `sha256:${string}`;
      object_key: string;
      visibility_sequence: string;
    }>(
      `SELECT p.*,h.projection_sequence AS visibility_sequence FROM public_skill_projections p JOIN public_skill_projection_heads h
        ON h.workspace_id = p.workspace_id AND h.skill_id = p.skill_id AND h.state = 'published'
        WHERE p.version_id = $1 AND p.state = 'published'`,
      [versionId],
    );
    const remote = projection.rows[0];
    if (
      !remote ||
      (globalLifecycle.withdrawn_sequence !== null &&
        BigInt(remote.visibility_sequence) <=
          BigInt(globalLifecycle.withdrawn_sequence))
    )
      this.denied();
    const stored = await this.publicStorage.getCanonicalBundle(
      remote.object_key,
      remote.digest,
    );
    return {
      id: remote.version_id,
      workspace_id: remote.workspace_id,
      workspace_slug: remote.workspace_slug,
      skill_id: remote.skill_id,
      skill_slug: remote.skill_slug,
      semantic_version: remote.semantic_version,
      content_digest: remote.digest,
      r2_object_key: remote.object_key,
      visibility: "public",
      archived_at: null,
      status: "published",
      deprecated_at: globalLifecycle.deprecated_at,
      revoked_at: null,
      bundle: await canonicalizeBundle(stored.bytes),
      publicSource: true,
    };
  }
  private lock(bundle: CanonicalBundle): DependencyLock {
    if (bundle.skill.formatVersion === 1) return emptyLock();
    const bytes = bundle.files.get("skill.lock.json");
    if (!bytes)
      throw new DomainError(
        "SKILL_DEPENDENCY_CONFLICT",
        "Composite is missing its server lock",
        409,
      );
    try {
      const lock = JSON.parse(new TextDecoder().decode(bytes)) as DependencyLock;
      if (!Array.isArray(lock.nodes) || !Array.isArray(lock.edges)) this.denied();
      return lock;
    } catch {
      return this.denied();
    }
  }
  private async node(source: Source): Promise<DependencyNode> {
    const lock = this.lock(source.bundle);
    validateLock(lock, {
      workspace: source.workspace_slug,
      skill: source.skill_slug,
      expandedBytes: source.bundle.manifest.expandedByteSize,
    });
    if (source.bundle.digest !== source.content_digest) this.denied();
    return {
      versionId: source.id,
      workspaceId: source.workspace_id,
      skillId: source.skill_id,
      workspace: source.workspace_slug,
      skill: source.skill_slug,
      semanticVersion: source.semantic_version,
      digest: source.content_digest,
      closureDigest: await compositionDigest(source.content_digest, lock),
      expandedBytes: source.bundle.manifest.expandedByteSize,
    };
  }
  private async choices(
    dependency: SkillDependency,
    principal: Principal,
  ): Promise<DependencyChoice[]> {
    const workspace = await this.controlPool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE slug = $1",
      [dependency.workspace],
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) this.denied();
    const rows = await this.pool.query<{
      id: string;
      semantic_version: string;
      manifest: { expandedByteSize: number };
    }>(
      `SELECT v.id,v.semantic_version,v.manifest FROM skill_versions v JOIN skills s ON s.id = v.skill_id
      LEFT JOIN skill_version_lifecycle lifecycle ON lifecycle.version_id = v.id
      WHERE s.workspace_id = $1 AND s.slug = $2 AND v.status = 'published'
      AND (s.workspace_id = $3 OR (s.visibility = 'public' AND s.archived_at IS NULL)) AND lifecycle.revoked_at IS NULL AND ($4::text IS NULL OR v.semantic_version=$4)
      ORDER BY v.revision DESC LIMIT 101`,
      [workspaceId, dependency.skill, principal.workspaceId, valid(dependency.version)],
    );
    let ids = rows.rows
      .filter((r) => satisfies(r.semantic_version, dependency.version))
      .map((r) => r.id);
    if (!ids.length && workspaceId !== principal.workspaceId) {
      const publicRows = await this.controlPool.query<{
        version_id: string;
        semantic_version: string;
      }>(
        `SELECT p.version_id,p.semantic_version FROM public_skill_projections p JOIN public_skill_projection_heads h
        ON h.workspace_id = p.workspace_id AND h.skill_id = p.skill_id AND h.state = 'published'
        WHERE p.workspace_slug = $1 AND p.skill_slug = $2 AND p.state = 'published' AND NOT EXISTS (SELECT 1 FROM public_skill_version_lifecycle l WHERE l.version_id=p.version_id AND (l.revoked_at IS NOT NULL OR h.projection_sequence<=l.withdrawn_sequence)) AND ($3::text IS NULL OR p.semantic_version=$3) ORDER BY p.published_at DESC LIMIT 101`,
        [dependency.workspace, dependency.skill, valid(dependency.version)],
      );
      ids = publicRows.rows
        .filter((r) => satisfies(r.semantic_version, dependency.version))
        .map((r) => r.version_id);
    }
    if (ids.length > 100)
      throw new DomainError(
        "SKILL_DEPENDENCY_CONFLICT",
        "Too many dependency versions; use a narrower publication catalog",
        409,
      );
    const choices: DependencyChoice[] = [];
    let expandedBytes = 0;
    for (const id of ids) {
      const source = await this.source(id, principal);
      expandedBytes += source.bundle.manifest.expandedByteSize;
      if (expandedBytes > COMPOSITION_LIMITS.expandedBytes)
        throw new DomainError(
          "SKILL_DEPENDENCY_CONFLICT",
          "Dependency version search exceeds expanded byte budget; use a narrower range",
          409,
        );
      choices.push({ node: await this.node(source), lock: this.lock(source.bundle) });
    }
    return choices;
  }
  // Only the authored root is needed to replace unsafe pins. Never return child content.
  async upgradeBundle(versionId: string, skillId: string, principal: Principal) {
    authorize(principal, "skills:write");
    const source = await this.source(versionId, principal);
    if (
      source.workspace_id !== principal.workspaceId ||
      source.skill_id !== skillId ||
      source.status !== "published"
    )
      this.denied();
    return source.bundle;
  }
  async upgradePreview(versionId: string, principal: Principal, skillId?: string) {
    authorize(principal, "skills:read");
    const source = await this.source(versionId, principal);
    if (
      (skillId && source.skill_id !== skillId) ||
      source.workspace_id !== principal.workspaceId ||
      source.status !== "published"
    )
      this.denied();
    const before = this.lock(source.bundle);
    const prepared = await this.prepare(source.bundle, principal, source.visibility);
    const after = prepared.lock;
    return {
      available: prepared.bundle.digest !== source.bundle.digest,
      beforeClosureDigest: await compositionDigest(source.bundle.digest, before),
      afterClosureDigest: prepared.closureDigest,
      added: after.nodes.filter(
        (n) => !before.nodes.some((b) => b.versionId === n.versionId),
      ),
      removed: before.nodes.filter(
        (n) => !after.nodes.some((a) => a.versionId === n.versionId),
      ),
      beforeEdges: before.edges,
      afterEdges: after.edges,
    };
  }
  async prepare(
    bundle: CanonicalBundle,
    principal: Principal,
    visibility: string,
    preserveLock = false,
  ): Promise<PreparedComposition> {
    const started = performance.now();
    try {
      const result = await this.prepareBundle(
        bundle,
        principal,
        visibility,
        preserveLock,
      );
      if (bundle.skill.formatVersion === 2)
        console.info(
          JSON.stringify({
            event: "skill.resolution.completed",
            nodes: result.lock.nodes.length,
            elapsedMs: Math.round(performance.now() - started),
          }),
        );
      return result;
    } catch (error) {
      console.info(
        JSON.stringify({
          event: "skill.resolution.failed",
          code: error instanceof DomainError ? error.code : "INTERNAL_ERROR",
          elapsedMs: Math.round(performance.now() - started),
        }),
      );
      throw error;
    }
  }
  private async prepareBundle(
    bundle: CanonicalBundle,
    principal: Principal,
    visibility: string,
    preserveLock = false,
  ): Promise<PreparedComposition> {
    if (bundle.skill.formatVersion === 1)
      return {
        bundle,
        lock: emptyLock(),
        closureDigest: await compositionDigest(bundle.digest, emptyLock()),
      };
    if (!this.writesEnabled)
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "Composition writes are disabled",
        503,
      );
    authorize(principal, "skills:read");
    const files = new Map(bundle.files);
    files.delete("skill.lock.json");
    const authored = await canonicalizeBundleFiles({ skill: bundle.skill, files });
    const root = {
      workspace: await this.workspaceSlug(principal.workspaceId),
      skill: bundle.skill.slug,
      expandedBytes: authored.manifest.expandedByteSize,
    };
    const lock = preserveLock
      ? this.lock(bundle)
      : await resolveDependencies({
          dependencies: bundle.skill.dependencies,
          root,
          choices: (d) => this.choices(d, principal),
        });
    validateLock(lock, root);
    await this.revalidate(lock, principal, visibility);
    files.set("skill.lock.json", new TextEncoder().encode(`${stableJson(lock)}\n`));
    const canonical = await canonicalizeBundleFiles({ skill: bundle.skill, files });
    validateLock(lock, { ...root, expandedBytes: canonical.manifest.expandedByteSize });
    return {
      bundle: canonical,
      lock,
      closureDigest: await compositionDigest(canonical.digest, lock),
    };
  }
  async revalidate(
    lock: DependencyLock,
    principal: Principal | null,
    visibility: string,
    db: Queryable = this.pool,
  ): Promise<Map<string, Source>> {
    const sources = new Map<string, Source>();
    for (const locked of lock.nodes) {
      const source = await this.source(locked.versionId, principal, db);
      if (source.status !== "published") this.denied();
      if (
        (visibility === "public" || source.workspace_id !== principal?.workspaceId) &&
        source.visibility !== "public"
      )
        this.denied();
      if (visibility === "workspace" && source.visibility === "private") this.denied();
      if (stableJson(await this.node(source)) !== stableJson(locked))
        throw new DomainError(
          "SKILL_DEPENDENCY_CONFLICT",
          "Locked dependency identity changed",
          409,
        );
      sources.set(locked.versionId, source);
    }
    return sources;
  }
  async persist(
    client: PoolClient,
    versionId: string,
    workspaceId: string,
    prepared: PreparedComposition,
  ): Promise<void> {
    if (prepared.bundle.skill.formatVersion === 1) return;
    for (const edge of prepared.lock.edges) {
      const child = prepared.lock.nodes.find((n) => n.versionId === edge.child);
      if (!child) this.denied();
      await client.query(
        `INSERT INTO skill_version_dependencies (workspace_id, root_version_id, parent_version_id, alias, ordinal, child_version_id, edge, node)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          workspaceId,
          versionId,
          edge.parent === "$root" ? versionId : edge.parent,
          edge.alias,
          edge.ordinal,
          edge.child,
          edge,
          child,
        ],
      );
    }
    await client.query(
      `INSERT INTO skill_version_compositions (workspace_id,version_id,format_version,dependency_closure_digest,dependency_lock)
      VALUES ($1,$2,2,$3,$4)`,
      [workspaceId, versionId, prepared.closureDigest, prepared.lock],
    );
  }
  async validatePublication(
    versionId: string,
    principal: Principal,
    visibility: string,
    db: Queryable,
  ): Promise<void> {
    const result = await db.query<{
      format_version: number;
      dependency_lock: DependencyLock | null;
      dependency_closure_digest: string | null;
    }>(
      "SELECT (v.manifest->>'formatVersion')::integer AS format_version,c.dependency_lock,c.dependency_closure_digest FROM skill_versions v LEFT JOIN skill_version_compositions c ON c.version_id=v.id AND c.workspace_id=v.workspace_id WHERE v.id=$1 AND v.workspace_id=$2",
      [versionId, principal.workspaceId],
    );
    const row = result.rows[0];
    if (row?.format_version === 2) {
      if (!this.writesEnabled)
        throw new DomainError(
          "SERVICE_UNAVAILABLE",
          "Composition writes are disabled",
          503,
        );
      if (!row.dependency_lock || !row.dependency_closure_digest)
        throw new DomainError(
          "SKILL_DEPENDENCY_CONFLICT",
          "Candidate has no immutable normalized lock",
          409,
        );
      const source = await this.source(versionId, principal, db);
      if (
        stableJson(row.dependency_lock) !== stableJson(this.lock(source.bundle)) ||
        row.dependency_closure_digest !== (await this.node(source)).closureDigest
      )
        throw new DomainError(
          "SKILL_DEPENDENCY_CONFLICT",
          "Candidate lock disagrees with its canonical bundle",
          409,
        );
      await this.revalidate(row.dependency_lock, principal, visibility, db);
    }
  }

  async resolve(
    versionId: string,
    principal: Principal | null,
    purpose: "execute" | "verify" = "execute",
    allowCandidate = false,
  ): Promise<CompositionPlan> {
    if (principal) authorize(principal, "skills:read");
    const source = await this.source(versionId, principal);
    if (
      source.status !== "published" &&
      !(
        allowCandidate &&
        principal &&
        principal.role !== "viewer" &&
        source.workspace_id === principal.workspaceId &&
        (principal.kind === "user" || principal.scopes.includes("skills:amend"))
      )
    )
      this.denied();
    const root = await this.node(source);
    const lock = this.lock(source.bundle);
    const sources = await this.revalidate(lock, principal, source.visibility);
    sources.set(versionId, source);
    const executionIds = new Set<string>();
    const verificationIds = new Set<string>();
    const visit = (id: string, execution: boolean) => {
      const parent = id === versionId ? "$root" : id;
      if (execution && executionIds.has(id)) return;
      if (!execution && verificationIds.has(id)) return;
      for (const edge of lock.edges.filter((e) => e.parent === parent))
        visit(edge.child, execution && edge.scope !== "verification");
      verificationIds.add(id);
      if (execution) executionIds.add(id);
    };
    visit(versionId, true);
    const module = (id: string, verify: boolean): ResolvedModule | null => {
      const s = sources.get(id);
      if (!s) this.denied();
      const skill = s.bundle.skill;
      const path = verify
        ? skill.formatVersion === 2
          ? skill.entrypoints.verify
          : undefined
        : "SKILL.md";
      if (!path) return null;
      return {
        versionId: id,
        workspace: s.workspace_slug,
        skill: s.skill_slug,
        digest: s.content_digest,
        instructions: new TextDecoder().decode(s.bundle.files.get(path)),
        files: s.bundle.manifest.files,
      };
    };
    const claims: CompositionPlan["verificationPlan"]["claims"] = [];
    for (const id of verificationIds) {
      const s = sources.get(id);
      if (!s) this.denied();
      if (s.bundle.skill.formatVersion === 2 && s.bundle.skill.verification) {
        const parsed = verificationClaimsSchema.parse(
          JSON.parse(
            new TextDecoder().decode(
              s.bundle.files.get(s.bundle.skill.verification.claims),
            ),
          ),
        );
        for (const claim of parsed)
          claims.push({
            ...claim,
            namespacedId: `${id}/${claim.id}`,
            originatingVersionId: id,
          });
      }
    }
    claims.sort((a, b) =>
      a.namespacedId < b.namespacedId ? -1 : a.namespacedId > b.namespacedId ? 1 : 0,
    );
    return {
      root,
      closureDigest: root.closureDigest,
      dag: lock,
      executionPlan: {
        modules:
          purpose === "verify"
            ? []
            : [...executionIds]
                .map((id) => module(id, false))
                .filter((m): m is ResolvedModule => m !== null),
        invocations:
          purpose === "verify"
            ? []
            : lock.edges.filter(
                (e) =>
                  e.mode === "invoke" &&
                  e.scope !== "verification" &&
                  executionIds.has(e.parent === "$root" ? versionId : e.parent),
              ),
      },
      verificationPlan: {
        modules: [...verificationIds]
          .map((id) => module(id, true))
          .filter((m): m is ResolvedModule => m !== null),
        claims,
      },
      warnings: [...sources.values()]
        .filter((s) => s.deprecated_at)
        .map((s) => `Deprecated version: ${s.id}`),
    };
  }
}
