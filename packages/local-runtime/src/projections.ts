import { requireValue } from "./contracts.js";
import {
  existsSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { stableJson, type CanonicalBundle } from "@skillplane/storage";
import { type LocalStore } from "./store.js";
import { hash, inventory, safeDirectory, syncDirectory, writeAtomic } from "./files.js";
import { RuntimeError, workspaceKey, type Snapshot, type Target } from "./contracts.js";
import { trustEnvelope, trustExpands, type TrustEnvelope } from "./trust.js";
import { projectionName, renderLauncher, targetDirectory } from "./adapters.js";
import { UsageQueue } from "./analytics.js";
export interface ProjectionRecord {
  project?: string;
  replacesId?: string;
  formatVersion: 1;
  id: string;
  eventId: string;
  installationId: string;
  name: string;
  target: Target;
  path: string;
  generation: string;
  workspace: Snapshot["workspace"];
  skill: Snapshot["skill"];
  version: Snapshot["version"];
  digest: string;
  synchronizedAt: string;
  trust: TrustEnvelope;
  files: Record<string, string>;
}
export function assertProjectionSupported(bundle: CanonicalBundle): void {
  if (bundle.skill.formatVersion === 2)
    throw new RuntimeError(
      "COMPOSITION_RESOLUTION_REQUIRED",
      "Use native MCP skill_resolve for composed skills; local projections cannot materialize dependency closures",
    );
}
export class Projections {
  constructor(
    readonly store: LocalStore,
    readonly fault?: (
      point: "before-write" | "before-swap" | "after-swap" | "before-unlink",
    ) => void,
  ) {
    this.store.transaction(() => {
      if (this.store.get("projection-owners:migrated")) return;
      const indexed = new Set<string>();
      for (const [key, ids] of this.store.entries<string[]>("project-projections:")) {
        const project = key.slice("project-projections:".length);
        for (const id of ids) {
          // Do not import ghost owners of previously uninstalled projections.
          if (!this.store.get(`projection:${id}`)) continue;
          this.addOwner(id, project);
          indexed.add(id);
        }
      }
      for (const [, record] of this.store.entries<ProjectionRecord>("projection:")) {
        // Existing per-ID owners take precedence over the historical installer.
        // Ownerless legacy records still need backfilling even if another ID has a ledger.
        if (record.project && !indexed.has(record.id))
          this.addOwner(record.id, record.project);
      }
      for (const [key] of this.store.entries("project-projections:"))
        this.store.delete(key);
      this.store.set("projection-owners:migrated", true);
    });
  }
  get(id: string): ProjectionRecord {
    const record = this.store.get<ProjectionRecord>(`projection:${id}`);
    if (!record) throw new RuntimeError("PROJECTION_NOT_FOUND");
    return record;
  }
  owners(record: ProjectionRecord): string[] {
    return this.store.db
      .prepare(
        "SELECT project FROM projection_owner WHERE projection_id=? ORDER BY project",
      )
      .all(record.id)
      .map((row) => String(row.project));
  }
  projectIds(project: string): string[] {
    return this.store.db
      .prepare(
        "SELECT projection_id FROM projection_owner WHERE project=? ORDER BY projection_id",
      )
      .all(resolve(project))
      .map((row) => String(row.projection_id));
  }
  private addOwner(id: string, project: string): void {
    this.store.db
      .prepare("INSERT OR IGNORE INTO projection_owner VALUES (?,?)")
      .run(id, resolve(project));
  }
  private assertReplacementOwner(record: ProjectionRecord, project: string): void {
    const owners = this.owners(record);
    if (
      !owners.includes(resolve(project)) ||
      owners.some((owner) => owner !== resolve(project))
    )
      throw new RuntimeError(
        "PROJECTION_COLLISION",
        "Destination is owned by another project",
      );
  }
  private rememberOwner(record: ProjectionRecord, project: string): void {
    this.addOwner(record.id, project);
    if (record.replacesId) {
      this.store.db
        .prepare("DELETE FROM projection_owner WHERE projection_id=?")
        .run(record.replacesId);
      this.store.delete(`projection:${record.replacesId}`);
    }
  }
  private assertCurrent(record: ProjectionRecord): void {
    if (this.store.get(`uninstall-journal:${record.id}`))
      throw new RuntimeError("PROJECTION_BUSY");
    if (
      this.store.get<ProjectionRecord>(`projection:${record.id}`)?.generation !==
      record.generation
    )
      throw new RuntimeError(
        "PROJECTION_CHANGED",
        "Projection changed; run sync again",
      );
  }
  private verifyForSync(record: ProjectionRecord): boolean {
    try {
      lstatSync(record.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      safeDirectory(dirname(record.path));
      return false;
    }
    this.verify(record);
    return true;
  }
  private verifyLink(record: ProjectionRecord): void {
    safeDirectory(dirname(record.path));
    if (
      !lstatSync(record.path).isSymbolicLink() ||
      resolve(dirname(record.path), readlinkSync(record.path)) !== record.generation
    )
      throw new RuntimeError("PROJECTION_DIVERGED");
  }
  verify(record: ProjectionRecord): void {
    this.verifyLink(record);
    if (stableJson(inventory(record.generation)) !== stableJson(record.files))
      throw new RuntimeError("PROJECTION_DIVERGED");
  }
  recover(): string[] {
    const recovered: string[] = [];
    for (const [, record] of this.store.entries<ProjectionRecord>(
      "uninstall-journal:",
    )) {
      this.finishUninstall(record);
      recovered.push(record.id);
    }
    this.store.transaction(() => {
      for (const [key, record] of this.store.entries<ProjectionRecord>("journal:")) {
        if (
          existsSync(record.path) &&
          lstatSync(record.path).isSymbolicLink() &&
          resolve(dirname(record.path), readlinkSync(record.path)) === record.generation
        ) {
          this.verify(record);
          const prior = this.store.get<ProjectionRecord>(`projection:${record.id}`);
          if (prior && prior.generation !== record.generation)
            this.store.set(`history:${record.id}:${prior.eventId}`, prior);
          this.store.set(`projection:${record.id}`, record);
          if (record.project) this.rememberOwner(record, record.project);
          this.recordInstall(record);
          recovered.push(record.id);
        }
        // Staged generations are retained for inspection, never mistaken for a live projection.
        this.store.delete(key);
      }
    });
    return recovered;
  }
  private validateSnapshot(snapshot: Snapshot): void {
    assertProjectionSupported(snapshot.bundle);
    if (
      !/^[A-Za-z0-9:_-]{1,160}$/.test(snapshot.version.id) ||
      (snapshot.version.semanticVersion !== null &&
        !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(
          snapshot.version.semanticVersion,
        ))
    )
      throw new RuntimeError("VERSION_ID_INVALID");
    if (snapshot.bundle.digest !== snapshot.version.digest)
      throw new RuntimeError("DIGEST_MISMATCH");
    if (snapshot.version.state !== "published")
      throw new RuntimeError("VERSION_NOT_PUBLISHED");
  }
  private approvedTrust(
    snapshot: Snapshot,
    id: string,
    old: ProjectionRecord | undefined,
  ): TrustEnvelope {
    const trust = trustEnvelope(snapshot.bundle);
    const approval = this.store.get<string>(`trust:${id}`);
    if (
      (old
        ? trustExpands(old.trust, trust)
        : Object.keys(trust.scripts).length > 0 ||
          trust.network.length > 0 ||
          trust.frontmatterDigest !== hash("") ||
          trust.executionDeclarations.length > 0) &&
      approval !== snapshot.bundle.digest
    ) {
      this.store.set(`pending-trust:${id}`, {
        digest: snapshot.bundle.digest,
        trust,
        source: workspaceKey(snapshot.workspace),
        skillId: snapshot.skill.id,
      });
      throw new RuntimeError(
        "TRUST_APPROVAL_REQUIRED",
        `Review projection ${id} digest ${snapshot.bundle.digest} with doctor, then approve-trust ${id} ${snapshot.bundle.digest}`,
      );
    }
    return trust;
  }
  private assertVacant(path: string): void {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new RuntimeError("PROJECTION_COLLISION", `Unowned target exists: ${path}`);
  }
  sync(
    snapshot: Snapshot,
    target: Target,
    project: string,
    name = snapshot.skill.slug,
  ): ProjectionRecord {
    this.validateSnapshot(snapshot);
    projectionName(name, target);
    const root = safeDirectory(targetDirectory(target, project));
    const path = join(root, name);
    const id = hash(
      `${path}\0${workspaceKey(snapshot.workspace)}\0${snapshot.skill.id}`,
    ).slice(0, 32);
    const old = this.store.get<ProjectionRecord>(`projection:${id}`);
    const replaced = old
      ? undefined
      : this.store
          .entries<ProjectionRecord>("projection:")
          .map(([, record]) => record)
          .find((record) => record.path === path);
    const sameState =
      old?.digest === snapshot.bundle.digest &&
      old.version.id === snapshot.version.id &&
      old.path === path &&
      old.target.adapter === target.adapter &&
      old.target.scope === target.scope &&
      stableJson(old.target.policy) === stableJson(target.policy);
    const changing = replaced ?? (sameState ? undefined : old);
    if (changing) this.assertReplacementOwner(changing, project);
    const existing = old ?? replaced;
    const present = existing ? this.verifyForSync(existing) : false;
    if (!existing) this.assertVacant(path);
    const trust = this.approvedTrust(snapshot, id, old);
    if (present && sameState) {
      return this.store.transaction(() => {
        this.assertCurrent(old);
        // Content was hashed before acquiring the writer lock. Protocol writers
        // replace generations, so only identity and the owned link need rechecking.
        this.verifyLink(old);
        this.rememberOwner(old, project);
        return old;
      });
    }
    this.fault?.("before-write");
    this.store.putBundle(snapshot.bundle);
    const generation = safeDirectory(
      join(dirname(root), ".skillplane-projections", id, randomUUID()),
    );
    const synchronizedAt = new Date().toISOString();
    const record: ProjectionRecord = {
      ...(replaced ? { replacesId: replaced.id } : {}),
      formatVersion: 1,
      project: resolve(project),
      id,
      eventId: randomUUID(),
      installationId: requireValue(this.store.get<string>("installation")),
      name,
      target,
      path,
      generation,
      workspace: snapshot.workspace,
      skill: snapshot.skill,
      version: snapshot.version,
      digest: snapshot.bundle.digest,
      synchronizedAt,
      trust,
      files: {},
    };
    for (const [file, bytes] of snapshot.bundle.files)
      writeAtomic(join(generation, "snapshot", file), bytes);
    // The portable manifest excludes installation paths and credentials.
    writeAtomic(
      join(generation, "projection.json"),
      stableJson({
        formatVersion: 1,
        id,
        workspace: snapshot.workspace,
        skill: snapshot.skill,
        version: snapshot.version,
        digest: snapshot.bundle.digest,
        synchronizedAt,
        policy: target.policy,
        trust,
      }),
    );
    writeAtomic(
      join(generation, "SKILL.md"),
      renderLauncher({
        home: this.store.root,
        id,
        name,
        description: snapshot.skill.description,
        target,
        source: workspaceKey(snapshot.workspace),
        version: snapshot.version.semanticVersion ?? snapshot.version.id,
        digest: snapshot.bundle.digest,
        synchronizedAt,
        body: new TextDecoder().decode(snapshot.bundle.files.get("SKILL.md")),
      }),
    );
    record.files = inventory(generation);
    this.store.set(`journal:${id}:${record.eventId}`, record);
    this.fault?.("before-swap");
    this.store.transaction(() => {
      if (existing) this.assertCurrent(existing);
      if (changing) this.assertReplacementOwner(changing, project);
      if (existing) this.verifyForSync(existing);
      else this.assertVacant(path);
      const link = join(root, `.skillplane-link-${randomUUID()}`);
      symlinkSync(relative(root, generation), link, "dir");
      renameSync(link, path);
      syncDirectory(root);
      this.fault?.("after-swap");
      if (old) this.store.set(`history:${id}:${old.eventId}`, old);
      this.store.set(`projection:${id}`, record);
      this.rememberOwner(record, project);
      this.store.delete(`journal:${id}:${record.eventId}`);
      this.store.delete(`pending-trust:${id}`);
      this.store.delete(`refresh:${id}`);
      this.recordInstall(record);
    });
    return record;
  }
  private recordInstall(record: ProjectionRecord): void {
    new UsageQueue(this.store).record({
      id: record.eventId,
      timestamp: record.synchronizedAt,
      type: "skill_projected",
      workspace: workspaceKey(record.workspace),
      skillId: record.skill.id,
      versionId: record.version.id,
      projectionId: record.id,
      installationId: record.installationId,
      agent: record.target.adapter,
      model: "unknown",
      modelTrust: "caller-declared",
      sessionId: null,
      delivery: "projection",
      freshness: record.target.policy.mode === "pinned" ? "pinned" : "verified",
      confidence: "observed",
      evidence: null,
    });
  }
  approve(id: string, digest: string): void {
    const pending = this.store.get<{
      digest: string;
    }>(`pending-trust:${id}`);
    if (pending?.digest !== digest) throw new RuntimeError("TRUST_APPROVAL_STALE");
    this.store.set(`trust:${id}`, digest);
  }
  async rollback(id: string): Promise<ProjectionRecord> {
    const current = this.get(id);
    const owners = this.owners(current);
    if (owners.length !== 1)
      throw new RuntimeError(
        "PROJECTION_SHARED",
        "Rollback requires one owning project",
      );
    const project = requireValue(owners[0]);
    this.verify(current);
    const previous = this.store
      .entries<ProjectionRecord>(`history:${id}:`)
      .map(([, value]) => value)
      .filter(
        (value) =>
          value.generation !== current.generation && value.digest !== current.digest,
      )
      .sort((a, b) => b.synchronizedAt.localeCompare(a.synchronizedAt))[0];
    if (!previous) throw new RuntimeError("ROLLBACK_UNAVAILABLE");
    if (stableJson(inventory(previous.generation)) !== stableJson(previous.files))
      throw new RuntimeError("PROJECTION_DIVERGED");
    const bundle = await this.store.bundle(previous.digest);
    // Explicit rollback selects an already-reviewed immutable version. Pin the
    // restored snapshot so the next invocation cannot immediately advance again.
    this.store.set(`trust:${id}`, previous.digest);
    return this.sync(
      {
        workspace: previous.workspace,
        skill: previous.skill,
        version: previous.version,
        bundle,
      },
      {
        ...previous.target,
        directory: dirname(previous.path),
        policy: {
          mode: "pinned",
          version: { kind: "pinned", id: previous.version.id },
        },
      },
      project,
      previous.name,
    );
  }
  private finishUninstall(record: ProjectionRecord): void {
    this.store.transaction(() => {
      const current = this.store.get<ProjectionRecord>(`projection:${record.id}`);
      // A stale journal must never remove a newer generation.
      if (current && current.generation !== record.generation) {
        this.store.delete(`uninstall-journal:${record.id}`);
        return;
      }
      if (this.owners(record).length > 1) throw new RuntimeError("PROJECTION_SHARED");
      safeDirectory(dirname(record.path));
      if (this.verifyForSync(record)) {
        this.fault?.("before-unlink");
        unlinkSync(record.path);
        syncDirectory(dirname(record.path));
      }
      this.store.delete(`projection:${record.id}`);
      this.store.db
        .prepare("DELETE FROM projection_owner WHERE projection_id=?")
        .run(record.id);
      this.store.delete(`uninstall-journal:${record.id}`);
    });
  }
  uninstall(id: string, project?: string): void {
    const record = this.store.transaction(() => {
      const current = this.get(id);
      const owners = this.owners(current);
      if (project !== undefined) {
        const owner = resolve(project);
        if (!owners.includes(owner)) throw new RuntimeError("PROJECTION_NOT_OWNED");
        if (owners.some((value) => value !== owner)) {
          this.store.db
            .prepare("DELETE FROM projection_owner WHERE projection_id=? AND project=?")
            .run(id, owner);
          return null;
        }
      } else if (owners.length > 1)
        throw new RuntimeError(
          "PROJECTION_SHARED",
          "Remove this target from each project's configuration first",
        );
      this.verifyForSync(current);
      this.store.set(`uninstall-journal:${id}`, current);
      return current;
    });
    if (record) this.finishUninstall(record);
  }
}
