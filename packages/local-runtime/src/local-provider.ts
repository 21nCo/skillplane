/* eslint @typescript-eslint/require-await: "off" -- Synchronous SQLite implements the asynchronous provider contract, including rejected errors. */
import { requireValue } from "./contracts.js";
import { randomUUID } from "node:crypto";
import { canonicalizeBundleFiles } from "@skillplane/storage";
import {
  createSkillBundle,
  applyAmendmentOperations,
  parseAmendmentOperations,
  nextSemanticVersion,
  parseLearningMetadata,
} from "@skillplane/domain";
import { skillCreateInputSchema, skillAmendInputSchema } from "@skillplane/mcp-schema";
import {
  RuntimeError,
  declaredCaller,
  type WorkspaceProvider,
  type WorkspaceRef,
  type SkillInfo,
  type PublishedSkill,
  type VersionInfo,
  type Snapshot,
  type CreateRequest,
  type AmendRequest,
} from "./contracts.js";
import { type LocalStore } from "./store.js";
type Row = Record<string, unknown>;
type Kind = SkillInfo["kind"];
// Published pre-kind runtimes read every skill and version row as a skill, so
// instructions documents use their own tables with the same columns. Slugs are
// unique per workspace across both kinds when this runtime creates an artifact.
// A pre-kind runtime checks only the skill table, so it can still create a skill
// whose slug an instructions document holds; both then coexist with distinct
// ids, and list orders them by slug, then kind.
const tables = {
  skill: { artifact: "skill", version: "version" },
  instructions: { artifact: "instructions", version: "instructions_version" },
} as const;
interface Artifact {
  readonly row: Row;
  readonly kind: Kind;
  readonly version: (typeof tables)[Kind]["version"];
}
function version(row: Row): VersionInfo {
  return {
    id: String(row.id),
    digest: String(row.digest),
    state: row.state as VersionInfo["state"],
    semanticVersion: typeof row.semantic === "string" ? row.semantic : null,
    createdAt: String(row.created),
  };
}
export class LocalWorkspaceProvider implements WorkspaceProvider {
  readonly workspace: Extract<
    WorkspaceRef,
    {
      provider: "local";
    }
  >;
  constructor(
    readonly store: LocalStore,
    workspaceId: string,
  ) {
    if (!store.db.prepare("SELECT id FROM workspace WHERE id=?").get(workspaceId))
      throw new RuntimeError("WORKSPACE_NOT_FOUND");
    this.workspace = { provider: "local", id: workspaceId };
  }
  static create(store: LocalStore, name: string): LocalWorkspaceProvider {
    if (!name.trim() || name.length > 120)
      throw new RuntimeError("WORKSPACE_NAME_INVALID");
    const id = store.transaction(() => {
      const row = store.db.prepare("SELECT id FROM workspace WHERE name=?").get(name);
      if (row) return String(row.id);
      const id = randomUUID();
      store.db.prepare("INSERT INTO workspace VALUES(?,?)").run(id, name);
      return id;
    });
    return new LocalWorkspaceProvider(store, id);
  }
  async list(kind?: SkillInfo["kind"]): Promise<SkillInfo[]> {
    const all = this.store.db
      .prepare(
        "SELECT id,slug,name,description,'skill' AS kind FROM skill WHERE workspace=? UNION ALL SELECT id,slug,name,description,'instructions' AS kind FROM instructions WHERE workspace=? ORDER BY slug,kind",
      )
      .all(this.workspace.id, this.workspace.id) as unknown as SkillInfo[];
    return kind ? all.filter((item) => item.kind === kind) : all;
  }
  // Local workspaces have no sharing settings or archive state, so every skill
  // whose current version is published exports as private.
  async publishedSkills(): Promise<PublishedSkill[]> {
    return this.store.db
      .prepare(
        "SELECT s.id,s.slug,s.current FROM skill s JOIN version v ON v.id=s.current AND v.skill=s.id WHERE s.workspace=? AND v.state='published' ORDER BY s.slug,s.id",
      )
      .all(this.workspace.id)
      .map((row) => ({
        id: String(row.id),
        slug: String(row.slug),
        versionId: String(row.current),
        visibility: "private" as const,
      }));
  }
  private skill(id: string): Artifact {
    for (const kind of ["skill", "instructions"] as const) {
      const row = this.store.db
        .prepare(`SELECT * FROM ${tables[kind].artifact} WHERE id=? AND workspace=?`)
        .get(id, this.workspace.id);
      if (row) return { row, kind, version: tables[kind].version };
    }
    throw new RuntimeError("SKILL_NOT_FOUND");
  }
  async versions(skillId: string): Promise<VersionInfo[]> {
    const skill = this.skill(skillId);
    return this.store.db
      .prepare(`SELECT * FROM ${skill.version} WHERE skill=? ORDER BY created DESC,id`)
      .all(skillId)
      .map(version);
  }
  async retrieve(skillId: string, versionId?: string): Promise<Snapshot> {
    const skill = this.skill(skillId);
    const row = this.store.db
      .prepare(`SELECT * FROM ${skill.version} WHERE skill=? AND id=?`)
      .get(skillId, versionId ?? String(skill.row.current));
    if (!row) throw new RuntimeError("VERSION_UNAVAILABLE");
    return {
      workspace: this.workspace,
      skill: {
        id: skillId,
        slug: String(skill.row.slug),
        name: String(skill.row.name),
        description: String(skill.row.description),
        kind: skill.kind,
      },
      version: version(row),
      bundle: await this.store.bundle(String(row.digest)),
    };
  }
  async create(request: CreateRequest): Promise<{
    skillId: string;
    versionId: string;
  }> {
    return this.insert(request, false);
  }
  /**
   * Creates an artifact whose only version is a draft awaiting review: nothing
   * is published and the artifact has no current version until a decision
   * approves the draft as 1.0.0. Given skillId, adds another draft to that
   * artifact instead, which must have the request's kind and slug and no
   * published version.
   */
  async createDraft(
    request: CreateRequest,
    skillId?: string,
  ): Promise<{
    skillId: string;
    versionId: string;
  }> {
    return this.insert(request, true, skillId);
  }
  /** Runs create's request checks and bundle construction, writing nothing. */
  async validate(request: CreateRequest): Promise<void> {
    await createSkillBundle(this.parse(request));
  }
  private parse(request: CreateRequest) {
    const input = skillCreateInputSchema.parse({
      ...request,
      workspace: { id: this.workspace.id },
      caller: declaredCaller(),
    });
    // Same contract as MCP skill_create, before bundle construction can fail opaquely.
    if (input.kind === "instructions" && (input.assets.length > 0 || input.composition))
      throw new RuntimeError(
        "VALIDATION_FAILED",
        "Instructions are a single AGENTS.md document without assets or composition",
      );
    if (input.composition)
      throw new RuntimeError(
        "COMPOSITION_RESOLUTION_REQUIRED",
        "Create composed skills in a cloud workspace using native MCP",
      );
    return input;
  }
  private async insert(
    request: CreateRequest,
    draft: boolean,
    existing?: string,
  ): Promise<{
    skillId: string;
    versionId: string;
  }> {
    const input = this.parse(request);
    const key = `${this.workspace.id}:${draft ? "draft" : "create"}:${existing ? `${existing}:` : ""}${input.idempotencyKey}`;
    const replay = this.store.replay<{
      skillId: string;
      versionId: string;
    }>(key, request);
    if (replay) return replay;
    const bundle = await createSkillBundle(input);
    this.store.putBundle(bundle);
    return this.store.transaction(() => {
      const replay = this.store.replay<{
        skillId: string;
        versionId: string;
      }>(key, request);
      if (replay) return replay;
      const target = tables[input.kind];
      if (existing !== undefined) {
        const artifact = this.skill(existing);
        if (artifact.kind !== input.kind || artifact.row.slug !== input.slug)
          throw new RuntimeError("SKILL_NOT_FOUND");
        if (artifact.row.current !== null)
          throw new RuntimeError("SKILL_VERSION_CONFLICT");
        const result = {
          skillId: existing,
          versionId: `skill-version:${randomUUID()}`,
        };
        const now = new Date().toISOString();
        this.store.db
          .prepare(
            `INSERT INTO ${target.version} VALUES(?,?,?,'draft',NULL,NULL,'patch',?,?,'{}',NULL)`,
          )
          .run(result.versionId, existing, bundle.digest, now, now);
        this.store.remember(key, request, result);
        return result;
      }
      if (
        this.store.db
          .prepare(
            "SELECT id FROM skill WHERE workspace=? AND slug=? UNION ALL SELECT id FROM instructions WHERE workspace=? AND slug=?",
          )
          .get(this.workspace.id, input.slug, this.workspace.id, input.slug)
      )
        throw new RuntimeError("SKILL_SLUG_CONFLICT");
      const result = {
        skillId: `skill:${randomUUID()}`,
        versionId: `skill-version:${randomUUID()}`,
      };
      this.store.db
        .prepare(`INSERT INTO ${target.artifact} VALUES(?,?,?,?,?,?)`)
        .run(
          result.skillId,
          this.workspace.id,
          input.slug,
          input.name,
          input.description,
          draft ? null : result.versionId,
        );
      const now = new Date().toISOString();
      this.store.db
        .prepare(
          `INSERT INTO ${target.version} VALUES(?,?,?,?,?,NULL,'patch',?,?,'{}',NULL)`,
        )
        .run(
          result.versionId,
          result.skillId,
          bundle.digest,
          draft ? "draft" : "published",
          draft ? null : "1.0.0",
          now,
          now,
        );
      this.store.remember(key, request, result);
      return result;
    });
  }
  /**
   * Proposes a review candidate. With unchanged, a candidate identical to its
   * base is allowed, as an adoption of the published bytes still needs review.
   */
  async amend(
    request: AmendRequest,
    options: { unchanged?: boolean } = {},
  ): Promise<{
    skillId: string;
    versionId: string;
  }> {
    const input = skillAmendInputSchema.parse({ ...request, caller: declaredCaller() });
    const learning = parseLearningMetadata(input.learning);
    if (learning.sourceContextId)
      throw new RuntimeError(
        "LOCAL_CONTEXT_UNAVAILABLE",
        "Local amendments do not reference cloud contexts",
      );
    const key = `${this.workspace.id}:amend:${input.idempotencyKey}`;
    const replay = this.store.replay<{
      skillId: string;
      versionId: string;
    }>(key, request);
    if (replay) return replay;
    const base = await this.retrieve(input.skillId, input.baseVersionId);
    if (this.skill(input.skillId).row.current !== input.baseVersionId)
      throw new RuntimeError("SKILL_VERSION_CONFLICT");
    const files = await applyAmendmentOperations(
      base.bundle.files,
      parseAmendmentOperations(input.changes),
    );
    const bundle = await canonicalizeBundleFiles({ skill: base.bundle.skill, files });
    if (bundle.digest === base.bundle.digest && !options.unchanged)
      throw new RuntimeError("UNCHANGED_BUNDLE");
    this.store.putBundle(bundle);
    return this.store.transaction(() => {
      const replay = this.store.replay<{
        skillId: string;
        versionId: string;
      }>(key, request);
      if (replay) return replay;
      const skill = this.skill(input.skillId);
      if (skill.row.current !== input.baseVersionId)
        throw new RuntimeError("SKILL_VERSION_CONFLICT");
      const result = {
        skillId: input.skillId,
        versionId: `skill-version:${randomUUID()}`,
      };
      const now = new Date().toISOString();
      this.store.db
        .prepare(
          `INSERT INTO ${skill.version} VALUES(?,?,?,'pending_review',NULL,?,?,?,?,?,NULL)`,
        )
        .run(
          result.versionId,
          input.skillId,
          bundle.digest,
          input.baseVersionId,
          input.proposedBump,
          now,
          now,
          JSON.stringify(learning),
        );
      this.store.remember(key, request, result);
      return result;
    });
  }
  /**
   * The versions of skillId this workspace's drafts and amendments created
   * under an idempotency key that is exactly prefix and 16 hex digits, latest
   * committed first whatever the clock said, in whatever state they are now,
   * so a caller recovers its own import after a review decided it. Only the
   * keys such a caller issues count: a new artifact's draft, a draft of
   * skillId and an amendment; a key merely containing prefix never does.
   */
  imports(
    prefix: string,
    skillId: string,
  ): {
    skillId: string;
    versionId: string;
    state: VersionInfo["state"];
    base: string | null;
  }[] {
    const scope = `${this.workspace.id}:`;
    const found = [];
    for (const row of this.store.db
      .prepare(
        "SELECT key,result FROM mutation WHERE substr(key,1,?)=? AND instr(key,?)>0 ORDER BY rowid DESC",
      )
      .all(scope.length, scope, `:${prefix}`)) {
      const operation = String(row.key).slice(scope.length);
      const issued = [
        `draft:${prefix}`,
        `draft:${skillId}:${prefix}`,
        `amend:${prefix}`,
      ];
      if (
        !issued.some(
          (start) =>
            operation.startsWith(start) &&
            /^[0-9a-f]{16}$/.test(operation.slice(start.length)),
        )
      )
        continue;
      const result = JSON.parse(String(row.result)) as {
        skillId: string;
        versionId: string;
      };
      if (result.skillId !== skillId) continue;
      let table: string;
      try {
        table = this.skill(result.skillId).version;
      } catch {
        continue;
      }
      const stored = this.store.db
        .prepare(`SELECT state,base FROM ${table} WHERE id=? AND skill=?`)
        .get(result.versionId, result.skillId);
      if (stored)
        found.push({
          ...result,
          state: stored.state as VersionInfo["state"],
          base: typeof stored.base === "string" ? stored.base : null,
        });
    }
    return found;
  }
  async candidates(skillId: string): Promise<Row[]> {
    const skill = this.skill(skillId);
    return this.store.db
      .prepare(
        `SELECT id AS reviewId, state, base, digest, updated AS expectedUpdatedAt, learning, reason FROM ${skill.version} WHERE skill=? AND state<>'published' ORDER BY created`,
      )
      .all(skillId);
  }
  async decide(
    skillId: string,
    reviewId: string,
    expectedUpdatedAt: string,
    approve: boolean,
    reason: string,
    idempotencyKey: string,
  ): Promise<VersionInfo> {
    if (
      typeof reason !== "string" ||
      !reason.trim() ||
      reason.length > 2000 ||
      typeof idempotencyKey !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(idempotencyKey)
    )
      throw new RuntimeError("DECISION_INVALID");
    const request = { skillId, reviewId, expectedUpdatedAt, approve, reason };
    const key = `${this.workspace.id}:decide:${idempotencyKey}`;
    return this.store.transaction(() => {
      const replay = this.store.replay<VersionInfo>(key, request);
      if (replay) return replay;
      const skill = this.skill(skillId);
      const row = this.store.db
        .prepare(`SELECT * FROM ${skill.version} WHERE skill=? AND id=?`)
        .get(skillId, reviewId);
      if (
        row?.updated !== expectedUpdatedAt ||
        !["draft", "pending_review"].includes(String(row.state))
      )
        throw new RuntimeError("REVIEW_CONFLICT");
      if (approve && row.base !== skill.row.current)
        throw new RuntimeError("SKILL_VERSION_CONFLICT");
      const base = row.base
        ? this.store.db
            .prepare(`SELECT semantic FROM ${skill.version} WHERE id=?`)
            .get(String(row.base))
        : null;
      const semantic = approve
        ? base
          ? nextSemanticVersion(
              String(base.semantic),
              row.bump as "patch" | "minor" | "major",
            )
          : "1.0.0"
        : null;
      this.store.db
        .prepare(
          `UPDATE ${skill.version} SET state=?,semantic=?,updated=?,reason=? WHERE id=?`,
        )
        .run(
          approve ? "published" : "rejected",
          semantic,
          new Date().toISOString(),
          reason,
          reviewId,
        );
      if (approve)
        this.store.db
          .prepare(`UPDATE ${tables[skill.kind].artifact} SET current=? WHERE id=?`)
          .run(reviewId, skillId);
      const result = version(
        requireValue(
          this.store.db
            .prepare(`SELECT * FROM ${skill.version} WHERE id=?`)
            .get(reviewId),
        ),
      );
      this.store.remember(key, request, result);
      return result;
    });
  }
}
