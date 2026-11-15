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
  | "before-write"
  | "after-stage"
  | "before-swap"
  | "after-rename"
  | "after-swap"
  | "before-unlink"
  | "before-discard"
  | "after-mark"
  | "before-restore-sync"
  | "before-recover-sync";
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
/** A replaced generation, numbered in the order its replacements committed. */
type InstructionHistory = InstructionRecord & { sequence?: number };
/** A temp file of a write that will never commit, kept until it is unlinked. */
interface InstructionCleanup {
  temp: string;
}
const CLEANUP_PREFIX = "instruction-cleanup:";
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
  /**
   * The project a committed write claims, or null for a write that claims
   * none (a rollback), so recovery commits the same owner set as the writer
   * would have. Absent in journals written before rollback existed, which
   * only a sync wrote and which claim their record's project.
   */
  owner?: string | null;
  /**
   * The target's uninstall mark when the writer read its state, or null
   * before any uninstall. Recovery commits nothing for a target released
   * since. Absent in journals written before release marks existed.
   */
  release?: string | null;
  pid: number;
  startedAt: string;
}
interface FileIdentity {
  dev: string;
  ino: string;
}
export type InstructionState =
  | "in-sync"
  | "diverged"
  | "missing"
  | "collision"
  | "not-synced"
  | "unverified"
  | "adopted";
/** A byte-for-byte copy of an instructions file, named by its digest. */
export interface InstructionBackup {
  path: string;
  /** SHA-256 of the copied bytes. */
  digest: string;
  mode: number;
  createdAt: string;
}
/**
 * A user's own instructions file handed to Skillplane. Its original bytes are
 * kept until uninstall restores them; sync takes the file over only while it
 * still holds those bytes, for the adopted artifact, once the adopted draft or
 * a later version is published.
 */
export interface InstructionAdoption {
  formatVersion: 1;
  id: string;
  project: string;
  path: string;
  artifact: string;
  /** Scopes the draft import's idempotency keys to this adoption. */
  nonce: string;
  original: InstructionBackup;
  /**
   * Set once the draft exists: the version holding the adopted bytes, which
   * is the artifact's current version when it already held them.
   */
  draft?: ArtifactIdentity & { versionId: string; createdAt: string };
}
/** A project whose configuration still names a target uninstall released. */
export interface InstructionUnconfigure {
  id: string;
  path: string;
  project: string;
}
/** A project's claim on a target and the check that must pass to add it. */
interface InstructionClaim {
  project: string;
  assert: () => void;
}
/** What sync knew when it planned an instructions target. */
export interface InstructionPlan {
  /** The published version IDs of the snapshot's artifact. */
  published?: ReadonlySet<string>;
  /** Uninstall marks, from releases(), read before the project's configuration. */
  releases?: ReadonlyMap<string, string>;
  userHome?: string;
}
const ADOPTION_PREFIX = "instruction-adoption:";
const RELEASE_PREFIX = "instruction-release:";
const UNINSTALL_PREFIX = "instruction-uninstall:";
const UNCONFIGURE_PREFIX = "instruction-unconfigure:";
/** An uninstall that may have replaced or removed the target before it committed. */
interface InstructionUninstall {
  id: string;
  path: string;
  /** The record the uninstall replaces, or null for an adoption that never synced. */
  eventId: string | null;
  /** The digest the target holds once restored, or null when it is removed. */
  restore: string | null;
  temp: string;
  pid: number;
  startedAt: string;
}
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
function sameArtifact(record: ArtifactIdentity, artifact: ArtifactIdentity): boolean {
  return (
    workspaceKey(record.workspace) === workspaceKey(artifact.workspace) &&
    record.skill.id === artifact.skill.id
  );
}
function writerAlive(journal: { pid: number; startedAt: string }): boolean {
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
/** The bytes of a regular instructions file, refusing links and oversized files. */
function readTarget(path: string): { bytes: Buffer; digest: string; mode: number } {
  const stat = lstatSync(path);
  const bytes = readSafe(path, MAX_INSTRUCTIONS_BYTES);
  return { bytes, digest: `sha256:${hash(bytes)}`, mode: stat.mode & 0o777 };
}
/** Where a target's backups live, beside its generations. */
function backupDirectory(path: string, id: string): string {
  return join(dirname(path), ".skillplane-projections", "instructions", id, "backup");
}
/**
 * Makes a rename or unlink in path's directory durable. A directory that no
 * longer exists holds nothing to lose.
 */
function syncParent(path: string): void {
  try {
    syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  /** Adds the project's claim once its assert passes, inside the caller's transaction. */
  private claim(id: string, owner: InstructionClaim): void {
    owner.assert();
    this.addOwner(id, owner.project);
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
  /** Whether the target has a record or an adoption, for rollback and uninstall. */
  known(id: string): boolean {
    return (
      this.store.get(`instruction:${id}`) !== undefined ||
      this.adoption(id) !== undefined
    );
  }
  adoption(id: string): InstructionAdoption | undefined {
    return this.store.get<InstructionAdoption>(`${ADOPTION_PREFIX}${id}`);
  }
  /**
   * Whether an unrecorded target may be written with the snapshot: an absent
   * one that was never adopted, or an adopted one, absent or still holding
   * its original bytes, for the adopted artifact once the adopted draft is
   * published.
   */
  private assertAdopted(
    path: string,
    observed: Observed,
    snapshot: Snapshot | undefined,
    published: ReadonlySet<string> | undefined,
  ): void {
    const adoption = this.adoption(InstructionProjections.id(path));
    if (!adoption) {
      if (observed.kind === "absent") return;
      throw new RuntimeError(
        "PROJECTION_COLLISION",
        `Unmanaged instructions file exists: ${path}`,
      );
    }
    if (
      observed.kind !== "absent" &&
      (observed.kind !== "file" || observed.digest !== adoption.original.digest)
    )
      throw new RuntimeError(
        "PROJECTION_DIVERGED",
        `${path} changed after it was adopted; it was not overwritten`,
      );
    const { draft } = adoption;
    if (!draft)
      throw new RuntimeError(
        "ADOPTION_INCOMPLETE",
        `${path} has no imported draft yet; run instructions adopt again to finish importing it`,
      );
    if (!snapshot || !sameArtifact(draft, snapshot))
      throw new RuntimeError(
        "PROJECTION_COLLISION",
        `${path} was adopted for the instructions artifact ${adoption.artifact}`,
      );
    // Published versions form one line, so the snapshot descends from the
    // draft once the draft is published.
    if (snapshot.version.id !== draft.versionId && !published?.has(draft.versionId))
      throw new RuntimeError(
        "ADOPTION_PENDING_REVIEW",
        `Publish the adopted draft ${draft.versionId} of ${adoption.artifact} before syncing ${path}; if it can no longer be published, run instructions adopt again`,
      );
  }
  private assertWritable(
    record: InstructionRecord | undefined,
    observed: Observed,
    path: string,
    snapshot?: Snapshot,
    published?: ReadonlySet<string>,
  ): void {
    if (!record) {
      this.assertAdopted(path, observed, snapshot, published);
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
  /** Uninstall marks by target ID, for InstructionPlan.releases. */
  releases(): Map<string, string> {
    return new Map(
      this.store
        .entries<string>(RELEASE_PREFIX)
        .map(([key, mark]) => [key.slice(RELEASE_PREFIX.length), mark]),
    );
  }
  /**
   * Refuses a target an uninstall released after the plan read the project's
   * configuration, or whose removal from it is still queued.
   */
  private assertPlanned(
    id: string,
    path: string,
    project: string,
    plan: InstructionPlan,
  ): void {
    if (!plan.releases) return;
    if (
      this.store.get(`${RELEASE_PREFIX}${id}`) !== plan.releases.get(id) ||
      this.store.get(`${UNCONFIGURE_PREFIX}${id}:${hash(resolve(project))}`)
    )
      throw new RuntimeError(
        "PROJECTION_CHANGED",
        `${path} was uninstalled after this sync read the configuration; run sync again`,
      );
  }
  private prepare(
    snapshot: Snapshot,
    target: InstructionTarget,
    project: string,
    plan: InstructionPlan,
  ) {
    const bytes = this.content(snapshot);
    const path = instructionPath(target, plan.userHome ?? homedir());
    const id = InstructionProjections.id(path);
    this.assertIdle(id, path);
    this.assertPlanned(id, path, project, plan);
    const old = this.store.get<InstructionRecord>(`instruction:${id}`);
    const digest = `sha256:${hash(bytes)}`;
    const observed = observe(path);
    this.assertWritable(old, observed, path, snapshot, plan.published);
    const same =
      old !== undefined &&
      observed.kind === "file" &&
      sameArtifact(old, snapshot) &&
      old.version.id === snapshot.version.id &&
      old.digest === digest;
    if (old && !same) this.assertReplacementOwner(old, snapshot, project);
    return { bytes, path, id, old, digest, same, release: this.releaseMark(id) };
  }
  /** The target's current uninstall mark, or null if it was never released. */
  private releaseMark(id: string): string | null {
    return this.store.get<string>(`${RELEASE_PREFIX}${id}`) ?? null;
  }
  /** Whether a dead writer's journal for this target is still unrecovered. */
  private recoveryPending(id: string): boolean {
    return this.store
      .entries<InstructionJournal>(`instruction-journal:${id}:`)
      .some(([, journal]) => !writerAlive(journal));
  }
  /**
   * Refuses while any write to the target may still land: a live writer's
   * journal, including one whose commit failed after its rename, or a dead
   * writer's unrecovered one. An uninstall that went ahead would release a
   * target such a write could then establish again.
   */
  private assertUnwritten(id: string, path: string): void {
    if (this.recoveryPending(id))
      throw new RuntimeError(
        "RECOVERY_PENDING",
        `An interrupted write to ${path} could not be recovered yet; the next run retries it`,
      );
    if (this.store.entries(`instruction-journal:${id}:`).length > 0)
      throw new RuntimeError(
        "PROJECTION_BUSY",
        `A write to ${path} is in progress or awaits recovery once its process stops; try again then`,
      );
  }
  /** Raises the error sync would raise, without writing anything. */
  check(
    snapshot: Snapshot,
    target: InstructionTarget,
    project: string,
    plan: InstructionPlan = {},
  ): void {
    safeDirectory(dirname(instructionPath(target, plan.userHome ?? homedir())), false);
    // Under the lock, a concurrent writer's renamed but uncommitted file is
    // never mistaken for an unmanaged one.
    this.store.transaction(() => this.prepare(snapshot, target, project, plan));
  }
  sync(
    snapshot: Snapshot,
    target: InstructionTarget,
    project: string,
    plan: InstructionPlan = {},
  ): InstructionRecord {
    const { bytes, path, id, old, digest, same, release } = this.store.transaction(() =>
      this.prepare(snapshot, target, project, plan),
    );
    const parent = safeDirectory(dirname(path));
    // Every commit that claims the target for this plan checks its release
    // fence first, so an uninstall since the plan is never undone by a claim.
    const owner: InstructionClaim = {
      project,
      assert: () => this.assertPlanned(id, path, project, plan),
    };
    const matches = (record: InstructionRecord): boolean =>
      sameArtifact(record, snapshot) &&
      record.version.id === snapshot.version.id &&
      record.digest === digest &&
      stateOf(record, observe(path)) === "in-sync";
    if (old && same)
      return this.store.transaction(() => {
        this.assertUninstalling(id, path);
        const current = this.store.get<InstructionRecord>(`instruction:${id}`);
        if (current?.eventId === old.eventId)
          this.assertWritable(current, observe(path), path);
        if (current?.eventId !== old.eventId || !matches(current))
          throw new RuntimeError(
            "PROJECTION_CHANGED",
            "Projection changed; run sync again",
          );
        this.claim(id, owner);
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
    return this.write({
      record,
      bytes,
      basis: old,
      release,
      owner,
      // Another lock holder committed first. Its result stands when it is the
      // same version; anything else needs a fresh plan.
      concurrent: matches,
      guard: (current, observed) => {
        owner.assert();
        this.assertWritable(current, observed, path, snapshot, plan.published);
        if (current) this.assertReplacementOwner(current, snapshot, project);
      },
    });
  }
  /**
   * Replaces the target with bytes by a journaled same-directory rename and
   * commits record in the same lock hold. guard runs under the lock before the
   * rename and throws to refuse it; a write whose basis is no longer current
   * returns the concurrent record when concurrent accepts it, else fails.
   * Either way owner, when given, is claimed only if its assert passes in
   * that commit.
   */
  private write(input: {
    record: InstructionRecord;
    bytes: Uint8Array;
    basis: InstructionRecord | undefined;
    /** The target's uninstall mark when the basis was read. */
    release: string | null;
    owner?: InstructionClaim;
    concurrent: (current: InstructionRecord) => boolean;
    guard: (current: InstructionRecord | undefined, observed: Observed) => void;
  }): InstructionRecord {
    const { record, bytes, owner } = input;
    const { id, path } = record;
    const parent = dirname(path);
    const journalKey = `instruction-journal:${id}:${record.eventId}`;
    const cleanupKey = `${CLEANUP_PREFIX}${id}:${record.eventId}`;
    const temp = join(parent, `.skillplane-instructions-${record.eventId}`);
    // Set once the target may be replaced. Until then nothing reached the
    // target, so the journal and temp file go; after it they stay for
    // recover(), which needs the temp file's absence as proof of the rename.
    const progress = { renaming: false };
    let result: InstructionRecord;
    try {
      // The journal is committed before the temp file exists, so recover()
      // can always find and remove a temp file a crash left behind. It names
      // the temp file's inode only once that file is staged and durable,
      // before the lock, so a crash between rename and commit can be completed
      // by recover(); the journal is deleted in the same commit as the record.
      const journal: InstructionJournal = {
        record,
        basis: input.basis?.eventId ?? null,
        temp,
        owner: owner ? resolve(owner.project) : null,
        release: input.release,
        pid: process.pid,
        startedAt: record.synchronizedAt,
      };
      this.store.set(journalKey, journal);
      journal.file = writeFileDurably(temp, bytes);
      this.fault?.("after-stage");
      this.store.set(journalKey, journal);
      result = this.store.transaction(() => {
        // An uninstall in flight owns the target until it commits or is dropped.
        this.assertUninstalling(id, path);
        const current = this.store.get<InstructionRecord>(`instruction:${id}`);
        if ((current?.eventId ?? null) !== journal.basis) {
          if (!current || !input.concurrent(current))
            throw new RuntimeError(
              "PROJECTION_CHANGED",
              "Projection changed; run sync again",
            );
          if (owner) this.claim(id, owner);
          this.retire(journalKey, cleanupKey, temp);
          return current;
        }
        const observed = observe(path);
        input.guard(current, observed);
        if (observed.kind === "file" && observed.mode !== 0o600)
          setMode(temp, observed.mode);
        progress.renaming = true;
        this.fault?.("before-swap");
        renameSync(temp, path);
        this.fault?.("after-rename");
        syncDirectory(parent);
        this.fault?.("after-swap");
        if (current) this.archive(current);
        this.store.set(`instruction:${id}`, record);
        if (owner) this.claim(id, owner);
        this.store.delete(journalKey);
        return record;
      });
    } catch (error) {
      if (!progress.renaming) {
        // Cleanup failures never replace the original error. A journal left
        // behind is rolled back by recover(), as is a cleanup entry.
        try {
          this.store.transaction(() => this.retire(journalKey, cleanupKey, temp));
        } catch {
          // The journal stays; the temp file is still removed below.
        }
        try {
          this.discard(cleanupKey, temp);
        } catch {
          // recover() removes the temp file its cleanup entry names.
        }
      }
      throw error;
    }
    // A renamed temp file is already gone and left no cleanup entry; a write
    // that lost the lock to the same version left both. The record is
    // committed either way, so a failed unlink is left to recover().
    this.discard(cleanupKey, temp);
    return result;
  }
  /**
   * Replaces a journal whose write will not be committed with a cleanup entry
   * naming its temp file, inside the caller's transaction. The temp file is
   * then always named by durable state until it is unlinked, and a cleanup
   * entry can never establish ownership.
   */
  private retire(journalKey: string, cleanupKey: string, temp: string): void {
    this.store.set(cleanupKey, { temp } satisfies InstructionCleanup);
    this.store.delete(journalKey);
  }
  /** Keeps a replaced generation for rollback, inside the caller's transaction. */
  private archive(record: InstructionRecord): void {
    const prefix = `instruction-history:${record.id}:`;
    const sequence = Math.max(
      -1,
      ...this.store
        .entries<InstructionHistory>(prefix)
        .map(([, value]) => value.sequence ?? -1),
    );
    this.store.set(`${prefix}${record.eventId}`, { ...record, sequence: sequence + 1 });
  }
  /**
   * Unlinks a retired temp file, then forgets it. An unlink that fails keeps
   * the cleanup entry for the next recover() and never fails the caller: the
   * entry is not project-scoped, so throwing would stop every sync, resolve
   * and doctor that shares the store.
   */
  private discard(cleanupKey: string, temp: string): void {
    this.fault?.("before-discard");
    try {
      rmSync(temp, { force: true });
    } catch {
      return;
    }
    this.store.delete(cleanupKey);
  }
  /**
   * Copies bytes into the target's backup directory under their digest, once.
   * Called under the lock; the copy is durable before any caller records it or
   * replaces the target.
   */
  private backup(
    path: string,
    id: string,
    file: { bytes: Uint8Array; digest: string; mode: number },
  ): InstructionBackup {
    const directory = safeDirectory(backupDirectory(path, id));
    const copy = join(directory, file.digest.slice(7));
    const existing = observe(copy);
    if (existing.kind !== "file" || existing.digest !== file.digest)
      writeAtomic(copy, file.bytes);
    // Every entry from the target's directory down to the copy, created now or
    // by a run that stopped before syncing them, survives a crash.
    for (let dir = directory; dir !== dirname(path); dir = dirname(dir))
      syncDirectory(dir);
    syncDirectory(dirname(path));
    return {
      path: copy,
      digest: file.digest,
      mode: file.mode,
      createdAt: new Date().toISOString(),
    };
  }
  /**
   * Backs up an unmanaged instructions file and records its adoption for the
   * artifact. A re-run for the same bytes and artifact returns the recorded
   * adoption without a second backup; the file itself is never changed.
   */
  adopt(input: {
    path: string;
    project: string;
    artifact: string;
    /** The digest of the bytes the caller validated, or null when it read none. */
    validated: string | null;
  }): {
    adoption: InstructionAdoption;
    bytes: Uint8Array;
    /** Whether this call recorded the adoption, rather than a run before it. */
    created: boolean;
  } {
    const path = resolve(input.path);
    const id = InstructionProjections.id(path);
    safeDirectory(dirname(path), false);
    return this.store.transaction(() => {
      this.assertIdle(id, path);
      if (this.store.get(`instruction:${id}`))
        throw new RuntimeError(
          "INSTRUCTIONS_MANAGED",
          `${path} is already managed by Skillplane`,
        );
      const observed = observe(path);
      if (observed.kind === "absent")
        throw new RuntimeError("INSTRUCTIONS_FILE_NOT_FOUND", `${path} does not exist`);
      if (observed.kind !== "file") throw new RuntimeError("UNSAFE_FILE");
      const file = readTarget(path);
      if (file.digest !== input.validated)
        throw new RuntimeError(
          "PROJECTION_CHANGED",
          `${path} changed while it was being adopted; run instructions adopt again`,
        );
      const key = `${ADOPTION_PREFIX}${id}`;
      const prior = this.adoption(id);
      if (prior) {
        if (prior.original.digest !== file.digest)
          throw new RuntimeError(
            "PROJECTION_DIVERGED",
            `${path} changed after it was adopted; uninstall ${id} restores the adopted original`,
          );
        if (
          prior.artifact !== input.artifact ||
          prior.project !== resolve(input.project)
        )
          throw new RuntimeError(
            "PROJECTION_COLLISION",
            `${path} was adopted for the instructions artifact ${prior.artifact}`,
          );
        // The recorded backup stands; a copy lost since is written again.
        this.backup(path, id, file);
        return { adoption: prior, bytes: file.bytes, created: false };
      }
      const adoption: InstructionAdoption = {
        formatVersion: 1,
        id,
        project: resolve(input.project),
        path,
        artifact: input.artifact,
        nonce: randomUUID(),
        original: this.backup(path, id, file),
      };
      this.store.set(key, adoption);
      return { adoption, bytes: file.bytes, created: true };
    });
  }
  /**
   * Undoes an adoption whose draft import failed, when it is still the one
   * this run recorded and has no draft: its record and backup copy go and the
   * file, never changed, stays the user's.
   */
  discardAdoption(adoption: InstructionAdoption): void {
    this.store.transaction(() => {
      const current = this.adoption(adoption.id);
      if (current?.nonce !== adoption.nonce || current.draft) return;
      this.store.delete(`${ADOPTION_PREFIX}${adoption.id}`);
      rmSync(adoption.original.path, { force: true });
    });
  }
  /** The adoption of a target sync has not taken over yet. */
  pendingAdoption(id: string): InstructionAdoption | undefined {
    return this.store.get(`instruction:${id}`) ? undefined : this.adoption(id);
  }
  /**
   * Records the imported draft of the adoption nonce names. The first record
   * stands unless it is the replaced draft, one that can no longer be
   * published.
   */
  recordDraft(
    id: string,
    nonce: string,
    draft: NonNullable<InstructionAdoption["draft"]>,
    replaced?: string,
  ): InstructionAdoption {
    return this.store.transaction(() => {
      const adoption = this.adoption(id);
      if (adoption?.nonce !== nonce)
        throw new RuntimeError(
          "PROJECTION_CHANGED",
          "The adoption was uninstalled while its draft was imported; run instructions adopt again",
        );
      if (adoption.draft && adoption.draft.versionId !== replaced) return adoption;
      const recorded = { ...adoption, draft };
      this.store.set(`${ADOPTION_PREFIX}${id}`, recorded);
      return recorded;
    });
  }
  /** Refuses while an interrupted write or uninstall of the target is unrecovered. */
  private assertIdle(id: string, path: string): void {
    if (this.recoveryPending(id))
      throw new RuntimeError(
        "RECOVERY_PENDING",
        `An interrupted write to ${path} could not be recovered yet; the next run retries it`,
      );
    this.assertUninstalling(id, path);
  }
  /** Refuses while an uninstall of the target is in flight. */
  private assertUninstalling(id: string, path: string): void {
    if (this.store.get(`${UNINSTALL_PREFIX}${id}`))
      throw new RuntimeError("PROJECTION_BUSY", `${path} is being uninstalled`);
  }
  /**
   * Restores the target's previous generation by the same journaled rename
   * sync uses. A hand-edited target is refused unless force, which first
   * backs the edited file up. The next sync applies the latest published
   * version again.
   */
  rollback(
    id: string,
    force = false,
  ): { record: InstructionRecord; backup: InstructionBackup | null } {
    const { current, previous, bytes, release } = this.store.transaction(() => {
      const current = this.store.get<InstructionRecord>(`instruction:${id}`);
      if (!current) throw new RuntimeError("PROJECTION_NOT_FOUND");
      this.assertIdle(id, current.path);
      // The latest replaced generation with other bytes, by commit order;
      // entries archived before the order was kept come after, by time.
      const latest = this.store
        .entries<InstructionHistory>(`instruction-history:${id}:`)
        .map(([, value]) => value)
        .filter((value) => value.digest !== current.digest)
        .sort(
          (a, b) =>
            (b.sequence ?? -1) - (a.sequence ?? -1) ||
            b.synchronizedAt.localeCompare(a.synchronizedAt),
        )[0];
      if (!latest) throw new RuntimeError("ROLLBACK_UNAVAILABLE");
      const previous: InstructionHistory = { ...latest };
      delete previous.sequence;
      this.assertRollbackOwner(current, previous);
      const staged = observe(previous.generation);
      if (staged.kind !== "file" || staged.digest !== previous.digest)
        throw new RuntimeError(
          "PROJECTION_DIVERGED",
          `The kept copy of version ${previous.version.id} changed`,
        );
      const bytes = readSafe(previous.generation, MAX_INSTRUCTIONS_BYTES);
      if (`sha256:${hash(bytes)}` !== previous.digest)
        throw new RuntimeError("PROJECTION_DIVERGED");
      this.assertEdit(current, observe(current.path), force);
      return { current, previous, bytes, release: this.releaseMark(id) };
    });
    let backup: InstructionBackup | null = null;
    const record = this.write({
      record: {
        ...previous,
        eventId: randomUUID(),
        installationId: requireValue(this.store.get<string>("installation")),
        project: current.project,
        synchronizedAt: new Date().toISOString(),
      },
      bytes,
      basis: current,
      release,
      concurrent: () => false,
      guard: (latest, observed) => {
        // A project may have claimed the target since the plan.
        if (latest) this.assertRollbackOwner(latest, previous);
        if (latest && this.assertEdit(latest, observed, force))
          backup = this.backup(latest.path, id, readTarget(latest.path));
      },
    });
    return { record, backup };
  }
  /**
   * Another project's claim blocks a rollback to a different artifact, which
   * would put that artifact into the file it configures.
   */
  private assertRollbackOwner(
    current: InstructionRecord,
    previous: InstructionRecord,
  ): void {
    if (
      !sameArtifact(previous, current) &&
      this.owners(current.id).some((owner) => owner !== current.project)
    )
      throw new RuntimeError(
        "PROJECTION_SHARED",
        "Another project configures this target for its current artifact",
      );
  }
  /** Refuses an uninstall of a target more than one project claims. */
  private assertUnshared(id: string): void {
    if (this.owners(id).length > 1)
      throw new RuntimeError(
        "PROJECTION_SHARED",
        "Remove this target from each project's configuration first",
      );
  }
  /**
   * Whether the target was hand-edited, refusing unless force. A target that
   * is not a regular file is refused even with force.
   */
  private assertEdit(
    record: InstructionRecord,
    observed: Observed,
    force: boolean,
  ): boolean {
    if (stateOf(record, observed) !== "diverged") return false;
    if (!force || observed.kind !== "file")
      throw new RuntimeError(
        "PROJECTION_DIVERGED",
        `${record.path} changed after Skillplane wrote it${force ? " and is not a regular file" : "; --force backs it up first"}`,
      );
    return true;
  }
  /**
   * Restores an adopted target's original bytes, or removes a target
   * Skillplane created, and clears its projection state. A hand-edited target
   * is refused unless force, which first backs the edited file up. A target
   * that already holds the original bytes, as after an uninstall interrupted
   * past its rename, needs only its state cleared.
   */
  uninstall(
    id: string,
    force = false,
  ): { restored: InstructionBackup | null; backup: InstructionBackup | null } {
    const marker = this.store.transaction(() => {
      const record = this.store.get<InstructionRecord>(`instruction:${id}`);
      const adoption = this.adoption(id);
      if (!record && !adoption) throw new RuntimeError("PROJECTION_NOT_FOUND");
      const path = record?.path ?? requireValue(adoption).path;
      this.assertUninstalling(id, path);
      this.assertUnwritten(id, path);
      this.assertUnshared(id);
      const marker: InstructionUninstall = {
        id,
        path,
        eventId: record?.eventId ?? null,
        restore: adoption?.original.digest ?? null,
        temp: join(dirname(path), `.skillplane-instructions-${randomUUID()}`),
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      // Committed before the target changes, so recover() can finish an
      // uninstall whose rename or unlink landed before its commit.
      this.store.set(`${UNINSTALL_PREFIX}${id}`, marker);
      return marker;
    });
    this.fault?.("after-mark");
    const progress = { replacing: false };
    let result: {
      restored: InstructionBackup | null;
      backup: InstructionBackup | null;
    };
    try {
      result = this.store.transaction(() => {
        const record = this.store.get<InstructionRecord>(`instruction:${id}`);
        const adoption = this.adoption(id);
        if (
          !this.store.get(`${UNINSTALL_PREFIX}${id}`) ||
          (record?.eventId ?? null) !== marker.eventId ||
          (adoption?.original.digest ?? null) !== marker.restore
        )
          throw new RuntimeError("PROJECTION_CHANGED", "Projection changed; try again");
        const { path } = marker;
        // Checked again in the commit that changes the target.
        this.assertUnwritten(id, path);
        this.assertUnshared(id);
        // Only a restore needs the directory; a removal never creates it.
        const parent = safeDirectory(dirname(path), adoption !== undefined);
        const observed = observe(path);
        // Divergence is decided by what Skillplane last wrote, or for a target
        // never synced by the adopted bytes, never by whether the file already
        // holds the original: a managed file hand-edited back to it is edited.
        const holdsOriginal =
          adoption !== undefined &&
          observed.kind === "file" &&
          observed.digest === adoption.original.digest;
        const edited = record
          ? stateOf(record, observed) === "diverged"
          : observed.kind !== "absent" && !holdsOriginal;
        if (edited && (!force || observed.kind !== "file"))
          throw new RuntimeError(
            "PROJECTION_DIVERGED",
            `${path} changed after Skillplane ${record ? "wrote" : "adopted"} it${force ? " and is not a regular file" : "; --force backs it up first"}`,
          );
        const backup = edited ? this.backup(path, id, readTarget(path)) : null;
        if (adoption && holdsOriginal) {
          // The bytes are already there: restore the saved mode and make the
          // data and its directory entry durable before the backup goes.
          this.fault?.("before-restore-sync");
          setMode(path, adoption.original.mode);
          syncDirectory(parent);
        } else if (adoption) {
          const original = readSafe(adoption.original.path, MAX_INSTRUCTIONS_BYTES);
          if (`sha256:${hash(original)}` !== adoption.original.digest)
            throw new RuntimeError(
              "BACKUP_INVALID",
              `The backup of ${path} at ${adoption.original.path} changed; nothing was restored`,
            );
          writeFileDurably(marker.temp, original);
          setMode(marker.temp, adoption.original.mode);
          progress.replacing = true;
          this.fault?.("before-swap");
          renameSync(marker.temp, path);
          this.fault?.("after-rename");
          syncDirectory(parent);
        } else if (observed.kind !== "absent") {
          progress.replacing = true;
          this.fault?.("before-unlink");
          unlinkSync(path);
          syncDirectory(parent);
        }
        this.forget(id);
        // The target now holds the original bytes, so its copy goes with the
        // adoption, under the lock so a concurrent adopt's copy is never lost.
        // Edited files backed up by force stay, even one with the same bytes.
        if (adoption && backup?.path !== adoption.original.path)
          try {
            rmSync(adoption.original.path, { force: true });
          } catch {
            // A leftover copy is harmless; the next adopt reuses it.
          }
        return { restored: adoption?.original ?? null, backup };
      });
    } catch (error) {
      if (!progress.replacing)
        try {
          rmSync(marker.temp, { force: true });
          this.store.transaction(() => {
            const current = this.store.get<InstructionUninstall>(
              `${UNINSTALL_PREFIX}${id}`,
            );
            if (current?.temp === marker.temp)
              this.store.delete(`${UNINSTALL_PREFIX}${id}`);
          });
        } catch {
          // recover() removes the marker and its temp file.
        }
      throw error;
    }
    return result;
  }
  /**
   * Clears a target's projection state inside the caller's transaction. The
   * projects that adopted, synced or claim it are queued to drop it from their
   * configuration, so their next sync neither refuses the restored file nor
   * writes the removed one again.
   */
  private forget(id: string): void {
    const record = this.store.get<InstructionRecord>(`instruction:${id}`);
    const adoption = this.adoption(id);
    const path = record?.path ?? adoption?.path;
    if (path !== undefined)
      for (const project of new Set(
        [record?.project, adoption?.project, ...this.owners(id)].filter(
          (value): value is string => value !== undefined,
        ),
      ))
        this.store.set(`${UNCONFIGURE_PREFIX}${id}:${hash(project)}`, {
          id,
          path,
          project,
        } satisfies InstructionUnconfigure);
    this.store.delete(`instruction:${id}`);
    for (const [key] of this.store.entries(`instruction-history:${id}:`))
      this.store.delete(key);
    this.store.delete(`${ADOPTION_PREFIX}${id}`);
    this.store.db.prepare("DELETE FROM projection_owner WHERE projection_id=?").run(id);
    this.store.delete(`${UNINSTALL_PREFIX}${id}`);
    // A sync planned before this commit never writes the target again.
    this.store.set(`${RELEASE_PREFIX}${id}`, randomUUID());
  }
  /** Configuration removals queued by uninstalls, with their keys. */
  unconfigurations(): [string, InstructionUnconfigure][] {
    return this.store.entries<InstructionUnconfigure>(UNCONFIGURE_PREFIX);
  }
  /**
   * Runs apply for a queued removal under the lock and drops it in the same
   * commit; apply throws to keep it queued.
   */
  unconfigure(key: string, apply: (entry: InstructionUnconfigure) => void): void {
    this.store.transaction(() => {
      const entry = this.store.get<InstructionUnconfigure>(key);
      if (!entry) return;
      apply(entry);
      this.store.delete(key);
    });
  }
  /**
   * Finishes an uninstall whose process stopped: one whose target already
   * holds the restored bytes, or is gone when nothing was to be restored, has
   * its state cleared; any other is dropped and the target stays managed.
   */
  private recoverUninstalls(): string[] {
    const recovered: string[] = [];
    for (const [key, marker] of this.store.entries<InstructionUninstall>(
      UNINSTALL_PREFIX,
    )) {
      if (writerAlive(marker)) continue;
      try {
        const finished = this.store.transaction(() => {
          const current = this.store.get<InstructionUninstall>(key);
          if (current?.temp !== marker.temp) return false;
          const record = this.store.get<InstructionRecord>(`instruction:${marker.id}`);
          const observed = observe(marker.path);
          const done =
            (record?.eventId ?? null) === marker.eventId &&
            (marker.restore === null
              ? observed.kind === "absent"
              : observed.kind === "file" && observed.digest === marker.restore);
          if (done) {
            // The uninstall may have stopped before making its rename or
            // unlink durable, or before restoring the saved mode. A failure
            // throws here, so the marker, the record and the owners stay for
            // the next run.
            this.fault?.("before-recover-sync");
            const adoption = this.adoption(marker.id);
            // setMode also makes the restored bytes durable.
            if (marker.restore !== null && adoption)
              setMode(marker.path, adoption.original.mode);
            syncParent(marker.path);
            this.forget(marker.id);
            // As uninstall does: the target holds the original bytes, so its
            // copy goes, under the lock. Edited files backed up by force stay.
            if (adoption)
              try {
                rmSync(adoption.original.path, { force: true });
              } catch {
                // A leftover copy is harmless; the next adopt reuses it.
              }
          } else this.store.delete(key);
          return done;
        });
        if (finished) recovered.push(marker.id);
        rmSync(marker.temp, { force: true });
      } catch {
        // The marker stays for the next run.
      }
    }
    return recovered;
  }
  /**
   * Finishes or rolls back writes whose process stopped between the journal
   * and the record commit. A target that is the journaled temp file, renamed
   * and unchanged, is committed; otherwise the record and owners stay as they
   * were, the staged temp file is removed and the target is left untouched.
   * Running it again is a no-op.
   */
  recover(): string[] {
    const recovered: string[] = this.recoverUninstalls();
    for (const [key, journal] of this.store.entries<InstructionJournal>(
      "instruction-journal:",
    )) {
      if (writerAlive(journal)) continue;
      const { record } = journal;
      const cleanupKey = `${CLEANUP_PREFIX}${key.slice("instruction-journal:".length)}`;
      let outcome: "gone" | "committed" | "retired";
      try {
        outcome = this.store.transaction(() => {
          // Another recovery handled it first.
          if (!this.store.get(key)) return "gone";
          const current = this.store.get<InstructionRecord>(`instruction:${record.id}`);
          if (
            (current?.eventId ?? null) === journal.basis &&
            // A target released since the writer read it is never claimed or
            // recorded again; uninstall also waits for every journal.
            (journal.release === undefined ||
              journal.release === this.releaseMark(record.id)) &&
            installed(journal) &&
            stateOf(record, observe(record.path)) === "in-sync"
          ) {
            // The writer may have stopped before making its rename durable. A
            // failed sync throws here and leaves the journal for the next run.
            syncDirectory(dirname(record.path));
            if (current) this.archive(current);
            this.store.set(`instruction:${record.id}`, record);
            // Only the claim the writer would have made: its guard checked
            // that claim under the lock that held the rename, and no release
            // happened since. A rollback claims nothing.
            const owner = journal.owner === undefined ? record.project : journal.owner;
            if (owner) this.addOwner(record.id, owner);
            this.store.delete(key);
            return "committed";
          }
          this.retire(key, cleanupKey, journal.temp);
          return "retired";
        });
      } catch {
        // The journal and the prior record stay; the next run retries, and
        // until then sync and doctor report this target as RECOVERY_PENDING.
        continue;
      }
      if (outcome === "committed") recovered.push(record.id);
      // Removed only once the journal is gone, so the temp file's inode cannot
      // be reused by another file while a journal still names it.
      if (outcome === "retired") this.discard(cleanupKey, journal.temp);
    }
    // Temp files of writes that will never commit, whose process stopped
    // before unlinking them, or whose unlink failed. Removal is by path and
    // never touches ownership; an entry that still cannot be removed stays.
    for (const [key, { temp }] of this.store.entries<InstructionCleanup>(
      CLEANUP_PREFIX,
    ))
      this.discard(key, temp);
    return recovered;
  }
  /**
   * What sync would find in a target that has no record: nothing, an
   * unmanaged file, or an adopted target, absent or still holding its original
   * bytes, unless edited since or the configured name resolves elsewhere.
   */
  private unrecordedState(
    id: string,
    path: string,
    resolution?: InstructionResolution,
  ): InstructionState {
    const observed = observe(path);
    const adoption = this.adoption(id);
    if (!adoption) return observed.kind === "absent" ? "not-synced" : "collision";
    // An absent adopted target stays adopted, as sync reports it.
    if (
      observed.kind !== "absent" &&
      (observed.kind !== "file" || observed.digest !== adoption.original.digest)
    )
      return "diverged";
    // An adoption without its draft yet is still adopted, as sync reports it.
    return resolution &&
      "identity" in resolution &&
      adoption.draft &&
      !sameArtifact(adoption.draft, resolution.identity)
      ? "collision"
      : "adopted";
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
        const pending = this.recoveryPending(record.id)
          ? { ...row, state: "RECOVERY_PENDING", fileState: row.state }
          : row;
        if (!entry || !scope) return pending;
        // sync resolves every name before it looks at any file.
        const { resolution } = entry;
        if ("code" in resolution)
          return { ...row, state: resolution.code, fileState: row.state };
        if (pending !== row) return pending;
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
          // Without a record any existing file is unmanaged unless adopted,
          // whatever the configured name resolves to.
          state: inspect(() => this.unrecordedState(id, path, resolution)),
        };
        // An adoption whose artifact does not exist yet is skipped by sync as
        // adopted rather than refused for the missing name.
        const adoptedOnly =
          "code" in resolution &&
          resolution.code === "INSTRUCTIONS_NOT_FOUND" &&
          this.adoption(id)?.artifact === target.artifact;
        rows.push(
          adoptedOnly
            ? row.state === "adopted"
              ? row
              : { ...row, state: "adopted", fileState: row.state }
            : "code" in resolution
              ? { ...row, state: resolution.code, fileState: row.state }
              : this.recoveryPending(id)
                ? { ...row, state: "RECOVERY_PENDING", fileState: row.state }
                : "unverified" in resolution
                  ? { ...row, state: "unverified", fileState: row.state }
                  : row,
        );
      }
      // An interrupted first write that recovery could not finish yet.
      for (const [, journal] of this.store.entries<InstructionJournal>(
        "instruction-journal:",
      )) {
        const { record } = journal;
        if (writerAlive(journal) || rows.some((row) => row.id === record.id)) continue;
        rows.push({
          id: record.id,
          adapter: record.adapter,
          artifact: record.artifact,
          path: record.path,
          version: record.version.semanticVersion ?? record.version.id,
          configured: false,
          state: "RECOVERY_PENDING",
          fileState: inspect(() => this.unrecordedState(record.id, record.path)),
        });
      }
      // Adopted files no project configures.
      for (const adoption of this.store
        .entries<InstructionAdoption>(ADOPTION_PREFIX)
        .map(([, value]) => value)) {
        if (rows.some((row) => row.id === adoption.id)) continue;
        rows.push({
          id: adoption.id,
          adapter: "generic",
          artifact: adoption.artifact,
          path: adoption.path,
          version: null,
          configured: false,
          state: inspect(() => this.unrecordedState(adoption.id, adoption.path)),
        });
      }
      return rows;
    });
  }
}
