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
  type VersionInfo,
  type Snapshot,
  type CreateRequest,
  type AmendRequest,
} from "./contracts.js";
import { type LocalStore } from "./store.js";
type Row = Record<string, unknown>;
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
  async list(): Promise<SkillInfo[]> {
    return this.store.db
      .prepare(
        "SELECT id,slug,name,description FROM skill WHERE workspace=? ORDER BY slug",
      )
      .all(this.workspace.id) as unknown as SkillInfo[];
  }
  private skill(id: string): Row {
    const row = this.store.db
      .prepare("SELECT * FROM skill WHERE id=? AND workspace=?")
      .get(id, this.workspace.id);
    if (!row) throw new RuntimeError("SKILL_NOT_FOUND");
    return row;
  }
  async versions(skillId: string): Promise<VersionInfo[]> {
    this.skill(skillId);
    return this.store.db
      .prepare("SELECT * FROM version WHERE skill=? ORDER BY created DESC,id")
      .all(skillId)
      .map(version);
  }
  async retrieve(skillId: string, versionId?: string): Promise<Snapshot> {
    const skill = this.skill(skillId);
    const row = this.store.db
      .prepare("SELECT * FROM version WHERE skill=? AND id=?")
      .get(skillId, versionId ?? String(skill.current));
    if (!row) throw new RuntimeError("VERSION_UNAVAILABLE");
    return {
      workspace: this.workspace,
      skill: {
        id: skillId,
        slug: String(skill.slug),
        name: String(skill.name),
        description: String(skill.description),
      },
      version: version(row),
      bundle: await this.store.bundle(String(row.digest)),
    };
  }
  async create(request: CreateRequest): Promise<{
    skillId: string;
    versionId: string;
  }> {
    const input = skillCreateInputSchema.parse({
      ...request,
      workspace: { id: this.workspace.id },
      caller: declaredCaller(),
    });
    const key = `${this.workspace.id}:create:${input.idempotencyKey}`;
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
      if (
        this.store.db
          .prepare("SELECT id FROM skill WHERE workspace=? AND slug=?")
          .get(this.workspace.id, input.slug)
      )
        throw new RuntimeError("SKILL_SLUG_CONFLICT");
      const result = {
        skillId: `skill:${randomUUID()}`,
        versionId: `skill-version:${randomUUID()}`,
      };
      this.store.db
        .prepare("INSERT INTO skill VALUES(?,?,?,?,?,?)")
        .run(
          result.skillId,
          this.workspace.id,
          input.slug,
          input.name,
          input.description,
          result.versionId,
        );
      const now = new Date().toISOString();
      this.store.db
        .prepare(
          "INSERT INTO version VALUES(?,?,?,'published','1.0.0',NULL,'patch',?,?,'{}',NULL)",
        )
        .run(result.versionId, result.skillId, bundle.digest, now, now);
      this.store.remember(key, request, result);
      return result;
    });
  }
  async amend(request: AmendRequest): Promise<{
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
    if (this.skill(input.skillId).current !== input.baseVersionId)
      throw new RuntimeError("SKILL_VERSION_CONFLICT");
    const files = await applyAmendmentOperations(
      base.bundle.files,
      parseAmendmentOperations(input.changes),
    );
    const bundle = await canonicalizeBundleFiles({ skill: base.bundle.skill, files });
    if (bundle.digest === base.bundle.digest)
      throw new RuntimeError("UNCHANGED_BUNDLE");
    this.store.putBundle(bundle);
    return this.store.transaction(() => {
      const replay = this.store.replay<{
        skillId: string;
        versionId: string;
      }>(key, request);
      if (replay) return replay;
      if (this.skill(input.skillId).current !== input.baseVersionId)
        throw new RuntimeError("SKILL_VERSION_CONFLICT");
      const result = {
        skillId: input.skillId,
        versionId: `skill-version:${randomUUID()}`,
      };
      const now = new Date().toISOString();
      this.store.db
        .prepare(
          "INSERT INTO version VALUES(?,?,?,'pending_review',NULL,?,?,?,?,?,NULL)",
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
  async candidates(skillId: string): Promise<Row[]> {
    this.skill(skillId);
    return this.store.db
      .prepare(
        "SELECT id AS reviewId, state, base, digest, updated AS expectedUpdatedAt, learning, reason FROM version WHERE skill=? AND state<>'published' ORDER BY created",
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
    if (!reason.trim() || reason.length > 2000 || !idempotencyKey)
      throw new RuntimeError("DECISION_INVALID");
    const request = { skillId, reviewId, expectedUpdatedAt, approve, reason };
    const key = `${this.workspace.id}:decide:${idempotencyKey}`;
    return this.store.transaction(() => {
      const replay = this.store.replay<VersionInfo>(key, request);
      if (replay) return replay;
      const skill = this.skill(skillId);
      const row = this.store.db
        .prepare("SELECT * FROM version WHERE skill=? AND id=?")
        .get(skillId, reviewId);
      if (
        row?.updated !== expectedUpdatedAt ||
        !["draft", "pending_review"].includes(String(row.state))
      )
        throw new RuntimeError("REVIEW_CONFLICT");
      if (approve && row.base !== skill.current)
        throw new RuntimeError("SKILL_VERSION_CONFLICT");
      const base = row.base
        ? this.store.db
            .prepare("SELECT semantic FROM version WHERE id=?")
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
        .prepare("UPDATE version SET state=?,semantic=?,updated=?,reason=? WHERE id=?")
        .run(
          approve ? "published" : "rejected",
          semantic,
          new Date().toISOString(),
          reason,
          reviewId,
        );
      if (approve)
        this.store.db
          .prepare("UPDATE skill SET current=? WHERE id=?")
          .run(reviewId, skillId);
      const result = version(
        requireValue(
          this.store.db.prepare("SELECT * FROM version WHERE id=?").get(reviewId),
        ),
      );
      this.store.remember(key, request, result);
      return result;
    });
  }
}
