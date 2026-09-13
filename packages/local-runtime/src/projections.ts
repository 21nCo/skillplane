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
import { stableJson } from "@skillplane/storage";
import { type LocalStore } from "./store.js";
import { hash, inventory, safeDirectory, syncDirectory, writeAtomic } from "./files.js";
import { RuntimeError, workspaceKey, type Snapshot, type Target } from "./contracts.js";
import { trustEnvelope, trustExpands, type TrustEnvelope } from "./trust.js";
import { projectionName, renderLauncher, targetDirectory } from "./adapters.js";
import { UsageQueue } from "./analytics.js";
export interface ProjectionRecord {
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
export class Projections {
  constructor(
    readonly store: LocalStore,
    readonly fault?: (point: "before-write" | "before-swap" | "after-swap") => void,
  ) {}
  get(id: string): ProjectionRecord {
    const record = this.store.get<ProjectionRecord>(`projection:${id}`);
    if (!record) throw new RuntimeError("PROJECTION_NOT_FOUND");
    return record;
  }
  verify(record: ProjectionRecord): void {
    safeDirectory(dirname(record.path));
    if (
      !lstatSync(record.path).isSymbolicLink() ||
      resolve(dirname(record.path), readlinkSync(record.path)) !== record.generation
    )
      throw new RuntimeError("PROJECTION_DIVERGED");
    if (stableJson(inventory(record.generation)) !== stableJson(record.files))
      throw new RuntimeError("PROJECTION_DIVERGED");
  }
  recover(): string[] {
    const recovered: string[] = [];
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
          this.recordInstall(record);
          recovered.push(record.id);
        }
        // Staged generations are retained for inspection, never mistaken for a live projection.
        this.store.delete(key);
      }
    });
    return recovered;
  }
  sync(
    snapshot: Snapshot,
    target: Target,
    project: string,
    name = snapshot.skill.slug,
  ): ProjectionRecord {
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
    projectionName(name, target);
    const root = safeDirectory(targetDirectory(target, project));
    const path = join(root, name);
    const id = hash(
      `${path}\0${workspaceKey(snapshot.workspace)}\0${snapshot.skill.id}`,
    ).slice(0, 32);
    const old = this.store.get<ProjectionRecord>(`projection:${id}`);
    if (old) this.verify(old);
    else {
      try {
        lstatSync(path);
        throw new RuntimeError(
          "PROJECTION_COLLISION",
          `Unowned target exists: ${path}`,
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
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
    if (
      old?.digest === snapshot.bundle.digest &&
      old.version.id === snapshot.version.id &&
      stableJson(old.target) === stableJson(target)
    )
      return old;
    this.fault?.("before-write");
    this.store.putBundle(snapshot.bundle);
    const generation = safeDirectory(
      join(dirname(root), ".skillplane-projections", id, randomUUID()),
    );
    const synchronizedAt = new Date().toISOString();
    const record: ProjectionRecord = {
      formatVersion: 1,
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
      if (old) this.verify(old);
      else {
        try {
          lstatSync(path);
          throw new RuntimeError("PROJECTION_COLLISION");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const link = join(root, `.skillplane-link-${randomUUID()}`);
      symlinkSync(relative(root, generation), link, "dir");
      renameSync(link, path);
      syncDirectory(root);
      this.fault?.("after-swap");
      if (old) this.store.set(`history:${id}:${old.eventId}`, old);
      this.store.set(`projection:${id}`, record);
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
      dirname(previous.path),
      previous.name,
    );
  }
  uninstall(id: string): void {
    const record = this.get(id);
    this.store.transaction(() => {
      this.verify(record);
      unlinkSync(record.path);
      syncDirectory(dirname(record.path));
      this.store.delete(`projection:${id}`);
    });
  }
}
