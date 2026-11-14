import { requireValue } from "./contracts.js";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  bundleEntrypoint,
  bundleKind,
  stableJson,
  type CanonicalBundle,
} from "@skillplane/storage";
import { type LocalStore } from "./store.js";
import {
  hash,
  inventory,
  readSafe,
  safeDirectory,
  syncDirectory,
  writeAtomic,
} from "./files.js";
import {
  RuntimeError,
  workspaceKey,
  type InstructionTarget,
  type Snapshot,
  type Target,
} from "./contracts.js";
import { trustEnvelope, trustExpands, type TrustEnvelope } from "./trust.js";
import {
  instructionPath,
  projectionName,
  renderLauncher,
  targetDirectory,
} from "./adapters.js";
import { UsageQueue } from "./analytics.js";
export type ProjectionFault =
  "before-write" | "before-swap" | "after-swap" | "before-unlink";
/** Instruction target IDs share the owner ledger with skill projection IDs. */
export const INSTRUCTIONS_ID_PREFIX = "instructions-";
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
  if (bundleKind(bundle.skill) !== "skill")
    throw new RuntimeError(
      "PROJECTION_KIND_UNSUPPORTED",
      "Instructions documents are not projected as skills",
    );
  if (bundle.skill.formatVersion === 2)
    throw new RuntimeError(
      "COMPOSITION_RESOLUTION_REQUIRED",
      "Use native MCP skill_resolve for composed skills; local projections cannot materialize dependency closures",
    );
}
function validateVersion(snapshot: Snapshot): void {
  if (
    !/^[A-Za-z0-9:_-]{1,160}$/.test(snapshot.version.id) ||
    (snapshot.version.semanticVersion !== null &&
      !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(snapshot.version.semanticVersion))
  )
    throw new RuntimeError("VERSION_ID_INVALID");
  if (snapshot.bundle.digest !== snapshot.version.digest)
    throw new RuntimeError("DIGEST_MISMATCH");
  if (snapshot.version.state !== "published")
    throw new RuntimeError("VERSION_NOT_PUBLISHED");
}
export class Projections {
  readonly instructions: InstructionProjections;
  constructor(
    readonly store: LocalStore,
    readonly fault?: (point: ProjectionFault) => void,
  ) {
    this.instructions = new InstructionProjections(store, fault);
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
        `SELECT projection_id FROM projection_owner WHERE project=? AND projection_id NOT LIKE '${INSTRUCTIONS_ID_PREFIX}%' ORDER BY projection_id`,
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
    return [...recovered, ...this.instructions.recover()];
  }
  private validateSnapshot(snapshot: Snapshot): void {
    assertProjectionSupported(snapshot.bundle);
    validateVersion(snapshot);
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

/** What Skillplane wrote to one user-level agent instructions file. */
export interface InstructionRecord {
  formatVersion: 1;
  kind: "instructions";
  id: string;
  eventId: string;
  installationId: string;
  /** The project whose sync wrote this generation. */
  project: string;
  adapter: InstructionTarget["adapter"];
  /** The configured artifact name in the project's instructions catalog. */
  artifact: string;
  path: string;
  /** Immutable copy of the bytes, kept beside the target for recovery. */
  generation: string;
  workspace: Snapshot["workspace"];
  skill: Snapshot["skill"];
  version: Snapshot["version"];
  bundleDigest: string;
  /** SHA-256 of the exact bytes written to path. */
  digest: string;
  synchronizedAt: string;
}
interface InstructionJournal {
  record: InstructionRecord;
  /** The eventId of the record this write replaces, or null for a first write. */
  basis: string | null;
  temp: string;
  /**
   * The device and inode of the staged temp file, which a rename keeps. Only a
   * target that is this file was installed by the write.
   */
  file?: FileIdentity;
  pid: number;
  startedAt: string;
}
interface FileIdentity {
  dev: string;
  ino: string;
}
export type InstructionState =
  "in-sync" | "diverged" | "missing" | "collision" | "not-synced" | "unverified";
export interface InstructionStatus {
  id: string;
  adapter: InstructionTarget["adapter"];
  artifact: string | null;
  path: string;
  version: string | null;
  configured: boolean;
  /** The artifact this project configures here when it is not the file's. */
  configuredArtifact?: string;
  /** Projects claiming the target, shown when the file belongs to another one. */
  owners?: string[];
  /**
   * An InstructionState, or the error code sync would raise first: a catalog
   * error such as SKILL_NAME_COLLISION, or the file's inspection error.
   */
  state: string;
  /** The file's own state when state is a catalog error or unverified. */
  fileState?: string;
}
/** The workspace and artifact ID of an instructions document. */
export interface ArtifactIdentity {
  workspace: Snapshot["workspace"];
  skill: { id: string };
}
/**
 * How sync would resolve a configured target's artifact name: the identity
 * from the project's catalog, the error sync would raise, or unverified when
 * the catalog cannot be read offline and no current identity was recorded.
 */
export type InstructionResolution =
  { identity: ArtifactIdentity } | { code: string } | { unverified: true };
/** The project doctor runs for and how sync would resolve each of its targets. */
export interface InstructionStatusScope {
  project: string;
  targets: readonly { target: InstructionTarget; resolution: InstructionResolution }[];
}
type Observed =
  | { kind: "absent" }
  | { kind: "other" }
  | { kind: "file"; digest: string | null; mode: number };
const MAX_INSTRUCTIONS_BYTES = 30 * 1024 * 1024;
// A journal older than any lock-bounded write belongs to a dead writer even
// when its process ID has been reused.
const JOURNAL_LEASE_MS = 10 * 60 * 1000;
function observe(path: string): Observed {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (!stat.isFile()) return { kind: "other" };
  return {
    kind: "file",
    digest:
      stat.size > MAX_INSTRUCTIONS_BYTES
        ? null
        : `sha256:${hash(readSafe(path, MAX_INSTRUCTIONS_BYTES))}`,
    mode: stat.mode & 0o777,
  };
}
function stateOf(record: InstructionRecord, observed: Observed): InstructionState {
  if (observed.kind === "absent") return "missing";
  if (observed.kind === "other" || observed.digest !== record.digest) return "diverged";
  return "in-sync";
}
function sameArtifact(record: InstructionRecord, artifact: ArtifactIdentity): boolean {
  return (
    workspaceKey(record.workspace) === workspaceKey(artifact.workspace) &&
    record.skill.id === artifact.skill.id
  );
}
function writerAlive(journal: InstructionJournal): boolean {
  // Instruction writes are synchronous, so this process has none in flight
  // while it recovers.
  if (journal.pid === process.pid) return false;
  if (Date.now() - Date.parse(journal.startedAt) > JOURNAL_LEASE_MS) return false;
  try {
    process.kill(journal.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
function writeFileDurably(path: string, bytes: Uint8Array): FileIdentity {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    const stat = fstatSync(fd, { bigint: true });
    return { dev: String(stat.dev), ino: String(stat.ino) };
  } finally {
    closeSync(fd);
  }
}
function setMode(path: string, mode: number): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/**
 * Whether the journaled write's rename landed: its staged temp file is gone
 * and the target is that file. Matching bytes alone are not proof, since a
 * user may have written the planned content themselves.
 */
function installed(journal: InstructionJournal): boolean {
  const { file } = journal;
  if (!file) return false;
  try {
    lstatSync(journal.temp);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  try {
    const stat = lstatSync(journal.record.path, { bigint: true });
    return (
      stat.isFile() && String(stat.dev) === file.dev && String(stat.ino) === file.ino
    );
  } catch {
    return false;
  }
}
/**
 * Projects one published instructions artifact into a single user-level file.
 * Targets are regular files replaced by same-directory rename; ownership is
 * the SHA-256 of the bytes last written, so an unmanaged or hand-edited file is
 * never overwritten. The store's write transaction is the projection lock.
 */
export class InstructionProjections {
  constructor(
    readonly store: LocalStore,
    readonly fault?: (point: ProjectionFault) => void,
  ) {}
  static id(path: string): string {
    return `${INSTRUCTIONS_ID_PREFIX}${hash(`instructions\0${resolve(path)}`).slice(0, 32)}`;
  }
  records(): InstructionRecord[] {
    return this.store
      .entries<InstructionRecord>("instruction:")
      .map(([, record]) => record);
  }
  owners(id: string): string[] {
    return this.store.db
      .prepare(
        "SELECT project FROM projection_owner WHERE projection_id=? ORDER BY project",
      )
      .all(id)
      .map((row) => String(row.project));
  }
  /** Instruction targets the project currently claims. */
  projectIds(project: string): string[] {
    return this.store.db
      .prepare(
        `SELECT projection_id FROM projection_owner WHERE project=? AND projection_id LIKE '${INSTRUCTIONS_ID_PREFIX}%' ORDER BY projection_id`,
      )
      .all(resolve(project))
      .map((row) => String(row.projection_id));
  }
  private addOwner(id: string, project: string): void {
    this.store.db
      .prepare("INSERT OR IGNORE INTO projection_owner VALUES (?,?)")
      .run(id, resolve(project));
  }
  /** Drops the project's claim on targets it no longer configures; files stay. */
  release(project: string, keep: ReadonlySet<string>): void {
    this.store.transaction(() => {
      for (const id of this.projectIds(project))
        if (!keep.has(id))
          this.store.db
            .prepare("DELETE FROM projection_owner WHERE projection_id=? AND project=?")
            .run(id, resolve(project));
    });
  }
  private content(snapshot: Snapshot): Uint8Array {
    if (bundleKind(snapshot.bundle.skill) !== "instructions")
      throw new RuntimeError(
        "PROJECTION_KIND_UNSUPPORTED",
        "Only instructions documents are projected to instruction files",
      );
    validateVersion(snapshot);
    const bytes = snapshot.bundle.files.get(bundleEntrypoint(snapshot.bundle.skill));
    if (!bytes) throw new RuntimeError("BUNDLE_INVALID");
    return bytes;
  }
  private assertWritable(
    record: InstructionRecord | undefined,
    observed: Observed,
    path: string,
  ): void {
    if (!record) {
      if (observed.kind !== "absent")
        throw new RuntimeError(
          "PROJECTION_COLLISION",
          `Unmanaged instructions file exists: ${path}`,
        );
      return;
    }
    if (stateOf(record, observed) === "diverged")
      throw new RuntimeError(
        "PROJECTION_DIVERGED",
        `${path} changed after Skillplane wrote it; it was not overwritten`,
      );
  }
  /**
   * The ownership rule for putting an artifact into a recorded target, shared
   * by sync and doctor. Projects that configure the same artifact may advance
   * it; a different artifact needs every other project to have released the
   * target first.
   */
  private ownership(
    record: InstructionRecord,
    artifact: ArtifactIdentity,
    project: string,
  ): "owned" | "replaceable" | "collision" {
    if (sameArtifact(record, artifact)) return "owned";
    return this.owners(record.id).some((owner) => owner !== resolve(project))
      ? "collision"
      : "replaceable";
  }
  private assertReplacementOwner(
    record: InstructionRecord,
    snapshot: Snapshot,
    project: string,
  ): void {
    if (this.ownership(record, snapshot, project) === "collision")
      throw new RuntimeError(
        "PROJECTION_COLLISION",
        `${record.path} is owned by another project's instructions`,
      );
  }
  private prepare(
    snapshot: Snapshot,
    target: InstructionTarget,
    project: string,
    userHome: string,
  ) {
    const bytes = this.content(snapshot);
    const path = instructionPath(target, userHome);
    const id = InstructionProjections.id(path);
    const old = this.store.get<InstructionRecord>(`instruction:${id}`);
    const digest = `sha256:${hash(bytes)}`;
    const observed = observe(path);
    this.assertWritable(old, observed, path);
    const same =
      old !== undefined &&
      observed.kind === "file" &&
      sameArtifact(old, snapshot) &&
      old.version.id === snapshot.version.id &&
      old.digest === digest;
    if (old && !same) this.assertReplacementOwner(old, snapshot, project);
    return { bytes, path, id, old, digest, same };
  }
  /** Raises the error sync would raise, without writing anything. */
  check(
    snapshot: Snapshot,
    target: InstructionTarget,
    project: string,
    userHome = homedir(),
  ): void {
    // Under the lock, a concurrent writer's renamed but uncommitted file is
    // never mistaken for an unmanaged one.
    this.store.transaction(() => this.prepare(snapshot, target, project, userHome));
  }
  sync(
    snapshot: Snapshot,
    target: InstructionTarget,
    project: string,
    userHome = homedir(),
  ): InstructionRecord {
    const { bytes, path, id, old, digest, same } = this.store.transaction(() =>
      this.prepare(snapshot, target, project, userHome),
    );
    const parent = safeDirectory(dirname(path));
    const matches = (record: InstructionRecord): boolean =>
      sameArtifact(record, snapshot) &&
      record.version.id === snapshot.version.id &&
      record.digest === digest &&
      stateOf(record, observe(path)) === "in-sync";
    if (old && same)
      return this.store.transaction(() => {
        const current = this.store.get<InstructionRecord>(`instruction:${id}`);
        if (current?.eventId === old.eventId)
          this.assertWritable(current, observe(path), path);
        if (current?.eventId !== old.eventId || !matches(current))
          throw new RuntimeError(
            "PROJECTION_CHANGED",
            "Projection changed; run sync again",
          );
        this.addOwner(id, project);
        return current;
      });
    this.fault?.("before-write");
    const generation = join(
      safeDirectory(
        join(
          parent,
          ".skillplane-projections",
          "instructions",
          id,
          encodeURIComponent(snapshot.version.id),
        ),
      ),
      bundleEntrypoint(snapshot.bundle.skill),
    );
    const staged = observe(generation);
    if (staged.kind !== "file" || staged.digest !== digest)
      writeAtomic(generation, bytes);
    const record: InstructionRecord = {
      formatVersion: 1,
      kind: "instructions",
      id,
      eventId: randomUUID(),
      installationId: requireValue(this.store.get<string>("installation")),
      project: resolve(project),
      adapter: target.adapter,
      artifact: target.artifact,
      path,
      generation,
      workspace: snapshot.workspace,
      skill: snapshot.skill,
      version: snapshot.version,
      bundleDigest: snapshot.bundle.digest,
      digest,
      synchronizedAt: new Date().toISOString(),
    };
    const journalKey = `instruction-journal:${id}:${record.eventId}`;
    const temp = join(parent, `.skillplane-instructions-${record.eventId}`);
    // Set once the target may be replaced. Until then nothing reached the
    // target, so the journal and temp file go; after it they stay for
    // recover(), which needs the temp file's absence as proof of the rename.
    const progress = { renaming: false };
    let result: InstructionRecord;
    try {
      // The temp file is staged and the journal naming its inode is committed
      // before the lock, so a crash between rename and commit can be completed
      // by recover(); the journal is deleted in the same commit as the record.
      const journal: InstructionJournal = {
        record,
        basis: old?.eventId ?? null,
        temp,
        file: writeFileDurably(temp, bytes),
        pid: process.pid,
        startedAt: record.synchronizedAt,
      };
      this.store.set(journalKey, journal);
      result = this.store.transaction(() => {
        const current = this.store.get<InstructionRecord>(`instruction:${id}`);
        if ((current?.eventId ?? null) !== journal.basis) {
          // Another lock holder committed first. Its result stands when it is
          // the same version; anything else needs a fresh plan.
          if (!current || !matches(current))
            throw new RuntimeError(
              "PROJECTION_CHANGED",
              "Projection changed; run sync again",
            );
          this.addOwner(id, project);
          this.store.delete(journalKey);
          return current;
        }
        const observed = observe(path);
        this.assertWritable(current, observed, path);
        if (current) this.assertReplacementOwner(current, snapshot, project);
        if (observed.kind === "file" && observed.mode !== 0o600)
          setMode(temp, observed.mode);
        progress.renaming = true;
        this.fault?.("before-swap");
        renameSync(temp, path);
        syncDirectory(parent);
        this.fault?.("after-swap");
        if (current)
          this.store.set(`instruction-history:${id}:${current.eventId}`, current);
        this.store.set(`instruction:${id}`, record);
        this.addOwner(id, project);
        this.store.delete(journalKey);
        return record;
      });
    } catch (error) {
      if (!progress.renaming) {
        this.store.delete(journalKey);
        rmSync(temp, { force: true });
      }
      throw error;
    }
    rmSync(temp, { force: true });
    return result;
  }
  /**
   * Finishes or rolls back writes whose process stopped between the journal
   * and the record commit. A target that is the journaled temp file, renamed
   * and unchanged, is committed; otherwise the record and owners stay as they
   * were, the staged temp file is removed and the target is left untouched.
   * Running it again is a no-op.
   */
  recover(): string[] {
    const recovered: string[] = [];
    for (const [key, journal] of this.store.entries<InstructionJournal>(
      "instruction-journal:",
    )) {
      if (writerAlive(journal)) continue;
      const { record } = journal;
      const completed = this.store.transaction(() => {
        if (!this.store.get(key)) return false;
        const current = this.store.get<InstructionRecord>(`instruction:${record.id}`);
        let done = false;
        if (
          (current?.eventId ?? null) === journal.basis &&
          installed(journal) &&
          stateOf(record, observe(record.path)) === "in-sync"
        ) {
          if (current)
            this.store.set(
              `instruction-history:${record.id}:${current.eventId}`,
              current,
            );
          this.store.set(`instruction:${record.id}`, record);
          this.addOwner(record.id, record.project);
          done = true;
        }
        this.store.delete(key);
        return done;
      });
      // Removed only once the journal is gone, so the temp file's inode cannot
      // be reused by another file while a journal still names it.
      rmSync(journal.temp, { force: true });
      if (completed) recovered.push(record.id);
    }
    return recovered;
  }
  /**
   * Every recorded target plus configured targets that have no record yet. A
   * configured target reports the decision sync would make for it: the
   * catalog error, then a hand edit, then the ownership rule for the
   * artifact its name resolves to.
   */
  status(scope?: InstructionStatusScope, userHome = homedir()): InstructionStatus[] {
    const inspect = (fn: () => InstructionState): string => {
      try {
        return fn();
      } catch (error) {
        return error instanceof RuntimeError ? error.code : "UNREADABLE";
      }
    };
    const configured = new Map<
      string,
      { target: InstructionTarget; resolution: InstructionResolution }
    >();
    for (const entry of scope?.targets ?? [])
      configured.set(
        InstructionProjections.id(instructionPath(entry.target, userHome)),
        entry,
      );
    // Read under the lock so an in-flight write is never reported as a hand edit.
    return this.store.transaction(() => {
      const rows: InstructionStatus[] = this.records().map((record) => {
        const row: InstructionStatus = {
          id: record.id,
          adapter: record.adapter,
          artifact: record.artifact,
          path: record.path,
          version: record.version.semanticVersion ?? record.version.id,
          configured: configured.has(record.id),
          state: inspect(() => stateOf(record, observe(record.path))),
        };
        const entry = configured.get(record.id);
        if (!entry || !scope) return row;
        // sync resolves every name before it looks at any file.
        const { resolution } = entry;
        if ("code" in resolution)
          return { ...row, state: resolution.code, fileState: row.state };
        // sync reports a hand edit or an unreadable file before ownership.
        if (row.state !== "in-sync" && row.state !== "missing") return row;
        if ("unverified" in resolution)
          return { ...row, state: "unverified", fileState: row.state };
        const decision = this.ownership(record, resolution.identity, scope.project);
        if (decision === "owned") return row;
        return {
          ...row,
          configuredArtifact: entry.target.artifact,
          owners: this.owners(record.id),
          state: decision === "collision" ? "collision" : "not-synced",
        };
      });
      for (const [id, { target, resolution }] of configured) {
        if (rows.some((row) => row.id === id)) continue;
        const path = instructionPath(target, userHome);
        const row: InstructionStatus = {
          id,
          adapter: target.adapter,
          artifact: target.artifact,
          path,
          version: null,
          configured: true,
          // Without a record any existing file is unmanaged, whatever the
          // configured name resolves to.
          state: inspect(() =>
            observe(path).kind === "absent" ? "not-synced" : "collision",
          ),
        };
        rows.push(
          "code" in resolution
            ? { ...row, state: resolution.code, fileState: row.state }
            : row,
        );
      }
      return rows;
    });
  }
}
