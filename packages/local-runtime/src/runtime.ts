import { requireValue } from "./contracts.js";
import { existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { bundleEntrypoint, bundleKind, canonicalizeBundle } from "@skillplane/storage";
import { type LocalStore } from "./store.js";
import { Profiles } from "./profiles.js";
import { LocalWorkspaceProvider } from "./local-provider.js";
import { CloudWorkspaceProvider } from "./cloud-provider.js";
import { instructionPath, targetDirectory } from "./adapters.js";
import {
  INSTRUCTIONS_ID_PREFIX,
  InstructionProjections,
  Projections,
  assertProjectionSupported,
  type ArtifactIdentity,
  type InstructionAdoption,
  type InstructionBackup,
  type InstructionPlan,
  type InstructionRecord,
  type InstructionResolution,
  type InstructionStatusScope,
  type ProjectionRecord,
} from "./projections.js";
import { UsageQueue } from "./analytics.js";
import { readSafe, writeAtomic, safeDirectory } from "./files.js";
import { trustEnvelope, trustExpands } from "./trust.js";
import {
  catalogName,
  instructionTargetSchema,
  policySchema,
  safeName,
  projectSchema,
  selectVersion,
  workspaceKey,
  RuntimeError,
  declaredCaller,
  type ProjectContext,
  type SkillInfo,
  type WorkspaceRef,
  type WorkspaceProvider,
  type Snapshot,
  type CreateRequest,
  type AmendRequest,
  type InstructionTarget,
} from "./contracts.js";
type CachedSnapshot = Omit<Snapshot, "bundle"> & {
  digest: string;
};
type CatalogEntry = Awaited<ReturnType<Runtime["catalog"]>>[number];
/**
 * The artifact each instructions target resolved to at the project's last
 * sync, so an offline doctor can apply sync's ownership rule to a cloud
 * catalog. It holds only while the catalog configuration is unchanged.
 */
interface InstructionClaims {
  catalog: string;
  targets: Record<string, { artifact: string } & ArtifactIdentity>;
}
/** The project's catalog sources in precedence order. */
function sources(context: ProjectContext): ProjectContext["mounts"][number][] {
  return [{ workspace: context.primary }, ...context.mounts];
}
const claimsKey = (project: string) => `instruction-claims:${resolve(project)}`;
/** Whether one destination is the other or contains it; writing one breaks the other. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}
/** Refuses an instructions destination that overlaps a skill destination. */
function assertNoSkillOverlap(
  paths: readonly string[],
  skills: readonly string[],
): void {
  for (const path of paths) {
    const skill = skills.find((destination) => overlaps(destination, path));
    if (skill !== undefined)
      throw new RuntimeError(
        "PROJECTION_COLLISION",
        `Instructions destination ${path} overlaps skill destination ${skill}`,
      );
  }
}
/** Fingerprint of the configuration that decides what a catalog name resolves to. */
/** The artifact a file is adopted into without --artifact: its slugged base name. */
function defaultArtifact(path: string): string {
  const slug = basename(path)
    .replace(/\.md$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  // Each run is one hyphen now, so trimming one at each edge is enough.
  return slug.slice(slug.startsWith("-") ? 1 : 0, slug.endsWith("-") ? -1 : undefined);
}
function catalogFingerprint(context: ProjectContext): string {
  const { primary, mounts, aliases, collisions } = context;
  return createHash("sha256")
    .update(JSON.stringify({ primary, mounts, aliases, collisions }))
    .digest("hex");
}
/**
 * The instructions target an argument names: its ID, or a file path that is
 * absolute, relative to the working directory or starts with `~/`. A bare
 * name is a file in the working directory when known names an instructions
 * target there, else a skill projection ID, which yields undefined.
 */
export function instructionTargetId(
  argument: string,
  known: (id: string) => boolean = () => false,
): string | undefined {
  if (argument.startsWith(INSTRUCTIONS_ID_PREFIX)) return argument;
  if (argument.startsWith("~/"))
    return InstructionProjections.id(resolve(homedir(), argument.slice(2)));
  if (/[\\/]/.test(argument) || argument.startsWith("."))
    return InstructionProjections.id(resolve(argument));
  const id = InstructionProjections.id(resolve(argument));
  return known(id) ? id : undefined;
}
/**
 * The create request that imports bytes unchanged, refusing bytes that are
 * not UTF-8.
 */
function draftRequest(
  path: string,
  bytes: Uint8Array,
  fields: { slug: string; name: string; description: string },
  idempotencyKey: string,
): CreateRequest {
  let instructions: string;
  try {
    instructions = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new RuntimeError(
      "INSTRUCTIONS_NOT_UTF8",
      `${path} is not UTF-8 text and cannot be imported unchanged`,
    );
  }
  return {
    kind: "instructions",
    ...fields,
    tags: [],
    visibility: "private",
    instructions,
    assets: [],
    idempotencyKey,
  };
}
/** The artifact's current version, or undefined when nothing is published. */
async function currentVersion(
  provider: LocalWorkspaceProvider,
  skillId: string,
): Promise<Snapshot | undefined> {
  try {
    return await provider.retrieve(skillId);
  } catch (error) {
    if (error instanceof RuntimeError && error.code === "VERSION_UNAVAILABLE")
      return undefined;
    throw error;
  }
}
/** The configured target an adopted file becomes when no project configures it. */
function adoptedTarget(path: string, artifact: string): InstructionTarget {
  for (const adapter of ["claude", "codex"] as const)
    if (instructionPath({ adapter, scope: "user", artifact }) === path)
      return instructionTargetSchema.parse({ adapter, artifact });
  return instructionTargetSchema.parse({ adapter: "generic", path, artifact });
}
/** A configured adopted target sync left alone, and why. */
export interface PendingAdoption {
  kind: "instructions";
  id: string;
  path: string;
  artifact: string;
  state: "adopted";
  code: "ADOPTION_PENDING_REVIEW" | "ADOPTION_INCOMPLETE";
}
export interface Resolution {
  source: "live-cli" | "cached-cli";
  freshness: "verified" | "unverified" | "pinned";
  version: Snapshot["version"];
  useEmbedded: boolean;
  instructions?: string;
  resourceDirectory?: string;
  refreshScheduled: boolean;
  disclosure: string;
}
export class Runtime {
  readonly profiles: Profiles;
  readonly projections: Projections;
  readonly usage: UsageQueue;
  constructor(
    readonly store: LocalStore,
    readonly providerFactory?: (ref: WorkspaceRef) => WorkspaceProvider,
  ) {
    this.profiles = new Profiles(store);
    this.projections = new Projections(store);
    this.usage = new UsageQueue(store);
  }
  provider(ref: WorkspaceRef, agent = "unknown"): WorkspaceProvider {
    if (this.providerFactory) return this.providerFactory(ref);
    return ref.provider === "local"
      ? new LocalWorkspaceProvider(this.store, ref.id)
      : CloudWorkspaceProvider.fromProfiles(ref, this.profiles, declaredCaller(agent));
  }
  setup(
    project: string,
    name = "Personal",
    targets: ProjectContext["targets"] = [],
  ): ProjectContext {
    project = resolve(project);
    const path = join(project, "skillplane.json");
    if (existsSync(path)) return this.project(project);
    const local = LocalWorkspaceProvider.create(this.store, name);
    const context = projectSchema.parse({
      formatVersion: 1,
      primary: local.workspace,
      targets,
    });
    writeAtomic(path, JSON.stringify(context, null, 2) + "\n");
    return context;
  }
  project(project: string): ProjectContext {
    return projectSchema.parse(
      JSON.parse(readSafe(join(project, "skillplane.json"), 128 * 1024).toString()),
    );
  }
  configure(project: string, context: unknown): ProjectContext {
    const config = projectSchema.parse(context);
    writeAtomic(
      join(project, "skillplane.json"),
      JSON.stringify(config, null, 2) + "\n",
    );
    return config;
  }
  /**
   * The ordered visible names of one artifact kind. Skills and instructions
   * documents have separate namespaces; only skills are projected as skills.
   */
  async catalog(
    context: ProjectContext,
    kind: SkillInfo["kind"] = "skill",
  ): Promise<
    {
      name: string;
      provider: WorkspaceProvider;
      skillId: string;
    }[]
  > {
    context = projectSchema.parse(context);
    return this.names(context, sources(context), kind);
  }
  /** The catalog of the given sources, in order, under the project's naming rules. */
  private async names(
    context: ProjectContext,
    sources: readonly ProjectContext["mounts"][number][],
    kind: SkillInfo["kind"],
  ): Promise<CatalogEntry[]> {
    const names = new Map<
      string,
      {
        name: string;
        provider: WorkspaceProvider;
        skillId: string;
      }
    >();
    for (const source of sources) {
      const provider = this.provider(source.workspace);
      for (const skill of await provider.list(kind)) {
        if (skill.kind !== kind) continue;
        const name = catalogName(context, source, skill);
        const old = names.get(name);
        if (old) {
          if (
            old.skillId === skill.id &&
            workspaceKey(old.provider.workspace) === workspaceKey(source.workspace)
          )
            continue;
          if (context.collisions === "precedence") continue;
          throw new RuntimeError(
            "SKILL_NAME_COLLISION",
            `Resolve ${name} with a mount namespace, qualified alias, or explicit precedence`,
          );
        }
        names.set(name, { name, provider, skillId: skill.id });
      }
    }
    return [...names.values()];
  }
  async create(context: ProjectContext, request: CreateRequest): Promise<unknown> {
    return this.provider(projectSchema.parse(context).primary).create(request);
  }
  async amend(context: ProjectContext, request: AmendRequest): Promise<unknown> {
    return this.provider(projectSchema.parse(context).primary).amend(request);
  }
  private cache(snapshot: Snapshot): void {
    this.store.putBundle(snapshot.bundle);
    const cached: CachedSnapshot = {
      workspace: snapshot.workspace,
      skill: snapshot.skill,
      version: snapshot.version,
      digest: snapshot.bundle.digest,
    };
    this.store.set(
      `cache:${workspaceKey(snapshot.workspace)}:${snapshot.skill.id}:${snapshot.version.id}`,
      cached,
    );
  }
  async sync(project: string): Promise<ProjectionRecord[]> {
    return (await this.syncTargets(project)).projections;
  }
  /**
   * The checks sync applies to the instructions configuration alone, before
   * any catalog: the error for each target, in configuration order. Every
   * doctor resolution applies them first, whatever stands in for the catalog.
   */
  private instructionConfigErrors(
    targets: readonly InstructionTarget[],
  ): (RuntimeError | undefined)[] {
    const paths: string[] = [];
    return targets.map((target) => {
      const path = instructionPath(target);
      // Generations live under .skillplane-projections next to their target,
      // so no target may sit there.
      if (path.split(sep).includes(".skillplane-projections"))
        return new RuntimeError(
          "PROJECTION_COLLISION",
          `Instructions destination ${path} is inside a projection store`,
        );
      const other = paths.find((earlier) => overlaps(earlier, path));
      paths.push(path);
      if (other === undefined) return undefined;
      return new RuntimeError(
        "PROJECTION_COLLISION",
        other === path
          ? `Duplicate instructions destination: ${path}`
          : `Instructions destinations overlap: ${other} and ${path}`,
      );
    });
  }
  /**
   * Resolves each configured instructions target's name through the catalog,
   * in configuration order. A target sync must refuse carries its error.
   */
  private instructionTargets(
    targets: readonly InstructionTarget[],
    catalog: readonly CatalogEntry[],
  ): { target: InstructionTarget; item?: CatalogEntry; error?: RuntimeError }[] {
    const errors = this.instructionConfigErrors(targets);
    return targets.map((target, index) => {
      const error = errors[index];
      if (error) return { target, error };
      const item = catalog.find((entry) => entry.name === target.artifact);
      if (!item)
        return {
          target,
          error: new RuntimeError(
            "INSTRUCTIONS_NOT_FOUND",
            `No instructions document named ${target.artifact} in this project's workspaces`,
          ),
        };
      return { target, item };
    });
  }
  /**
   * Resolves every configured instructions target's latest published version.
   * An adopted target whose artifact has nothing to take it over with yet is
   * set aside as pending rather than stopping the sync.
   */
  private async instructionPlans(context: ProjectContext): Promise<{
    plans: { target: InstructionTarget; snapshot: Snapshot; published: Set<string> }[];
    pending: PendingAdoption[];
  }> {
    const targets = context.instructions ?? [];
    if (targets.length === 0) return { plans: [], pending: [] };
    const resolved = this.instructionTargets(
      targets,
      await this.catalog(context, "instructions"),
    );
    const plans = [];
    const pending: PendingAdoption[] = [];
    for (const { target, item, error } of resolved) {
      try {
        if (error || !item) throw error ?? new RuntimeError("INSTRUCTIONS_NOT_FOUND");
        const versions = await item.provider.versions(item.skillId);
        const selected = selectVersion(versions, policySchema.parse({}));
        plans.push({
          target,
          snapshot: await item.provider.retrieve(item.skillId, selected.id),
          published: new Set(
            versions.filter((v) => v.state === "published").map((v) => v.id),
          ),
        });
      } catch (failure) {
        const set = this.pendingAdoption(target, failure, [
          "INSTRUCTIONS_NOT_FOUND",
          "VERSION_UNAVAILABLE",
        ]);
        if (!set) throw failure;
        pending.push(set);
      }
    }
    return { plans, pending };
  }
  /**
   * The pending entry for an adopted target sync has not taken over, when the
   * failure is one of codes; undefined otherwise.
   */
  private pendingAdoption(
    target: InstructionTarget,
    failure: unknown,
    codes: readonly string[],
  ): PendingAdoption | undefined {
    if (!(failure instanceof RuntimeError) || !codes.includes(failure.code))
      return undefined;
    const path = instructionPath(target);
    const adoption = this.projections.instructions.pendingAdoption(
      InstructionProjections.id(path),
    );
    if (adoption?.artifact !== target.artifact) return undefined;
    return {
      kind: "instructions",
      id: adoption.id,
      path,
      artifact: target.artifact,
      state: "adopted",
      code: adoption.draft ? "ADOPTION_PENDING_REVIEW" : "ADOPTION_INCOMPLETE",
    };
  }
  /**
   * How sync would resolve each configured instructions target, for doctor.
   * Local catalogs are read offline; a cloud catalog is read when online,
   * otherwise the identity recorded at the last sync stands in for it while
   * the catalog configuration is unchanged, and anything else is unverified.
   */
  private async instructionResolutions(
    project: string,
    context: ProjectContext,
    online: boolean,
  ): Promise<InstructionStatusScope["targets"]> {
    const targets = context.instructions ?? [];
    if (targets.length === 0) return [];
    const all = sources(context);
    const firstCloud = all.findIndex((s) => s.workspace.provider === "cloud");
    if (firstCloud >= 0 && !online) {
      const claims = this.store.get<InstructionClaims>(claimsKey(project));
      const current = claims?.catalog === catalogFingerprint(context);
      const errors = this.instructionConfigErrors(targets);
      // Local workspaces are read offline. A name the local sources ahead of
      // every cloud source give under precedence is decided by them alone;
      // otherwise a recorded identity stands in only while it agrees with
      // what the local sources hold, since cloud contents can change the rest.
      let decided: CatalogEntry[];
      let local: CatalogEntry[];
      try {
        decided =
          context.collisions === "precedence"
            ? await this.names(context, all.slice(0, firstCloud), "instructions")
            : [];
        local = await this.names(
          context,
          all.filter((s) => s.workspace.provider !== "cloud"),
          "instructions",
        );
      } catch (error) {
        const code = error instanceof RuntimeError ? error.code : "CATALOG_UNAVAILABLE";
        return targets.map((target, index) => ({
          target,
          resolution: { code: errors[index]?.code ?? code },
        }));
      }
      const identity = (item: CatalogEntry): ArtifactIdentity => ({
        workspace: item.provider.workspace,
        skill: { id: item.skillId },
      });
      return targets.map((target, index) => {
        const error = errors[index];
        if (error) return { target, resolution: { code: error.code } };
        const item = decided.find((entry) => entry.name === target.artifact);
        if (item) return { target, resolution: { identity: identity(item) } };
        const held = local.find((entry) => entry.name === target.artifact);
        const claim = current
          ? claims.targets[InstructionProjections.id(instructionPath(target))]
          : undefined;
        // Under precedence a cloud source ahead of the first local holder
        // still wins over it. A workspace mounted more than once counts at its
        // last mount, since offline the name's mount is unknown.
        const positions = (workspace: ArtifactIdentity["workspace"]) =>
          all.flatMap((s, i) =>
            workspaceKey(s.workspace) === workspaceKey(workspace) ? [i] : [],
          );
        const agrees =
          claim?.artifact === target.artifact &&
          (held
            ? (workspaceKey(claim.workspace) ===
                workspaceKey(held.provider.workspace) &&
                claim.skill.id === held.skillId) ||
              (context.collisions === "precedence" &&
                claim.workspace.provider === "cloud" &&
                Math.max(...positions(claim.workspace)) <
                  Math.min(...positions(held.provider.workspace)))
            : claim.workspace.provider === "cloud");
        const resolution: InstructionResolution =
          claim && agrees
            ? { identity: { workspace: claim.workspace, skill: claim.skill } }
            : { unverified: true };
        return { target, resolution };
      });
    }
    let catalog: CatalogEntry[];
    try {
      catalog = await this.catalog(context, "instructions");
    } catch (error) {
      const code = error instanceof RuntimeError ? error.code : "CATALOG_UNAVAILABLE";
      return targets.map((target) => ({ target, resolution: { code } }));
    }
    return this.instructionTargets(targets, catalog).map(({ target, item, error }) => ({
      target,
      resolution: item
        ? {
            identity: {
              workspace: item.provider.workspace,
              skill: { id: item.skillId },
            },
          }
        : { code: error?.code ?? "INSTRUCTIONS_NOT_FOUND" },
    }));
  }
  /**
   * Hands an existing instructions file to Skillplane: backs it up byte for
   * byte, imports it as a draft of the artifact in the project's local primary
   * workspace (creating the artifact if needed) and configures the target.
   * Nothing is published and the file is not changed; once the draft is
   * published, sync takes the file over. A re-run after an interruption
   * reuses the backup and the draft; a deterministic import failure undoes
   * the adoption it recorded.
   */
  async adoptInstructions(
    project: string,
    file: string,
    artifact?: string,
  ): Promise<InstructionAdoption & { configured: InstructionTarget }> {
    this.projections.recover();
    project = resolve(project);
    this.applyUnconfigurations();
    const path = file.startsWith("~/")
      ? resolve(homedir(), file.slice(2))
      : resolve(file);
    const context = this.project(project);
    const configured = (context.instructions ?? []).find(
      (target) => instructionPath(target) === path,
    );
    if (configured && artifact !== undefined && artifact !== configured.artifact)
      throw new RuntimeError(
        "ARGUMENT_INVALID",
        `${path} is configured for the instructions artifact ${configured.artifact}`,
      );
    const name = artifact ?? configured?.artifact ?? defaultArtifact(path);
    if (!safeName.safeParse(name).success)
      throw new RuntimeError(
        "ARGUMENT_INVALID",
        "--artifact must be a lowercase slug naming the instructions artifact",
      );
    const target = configured ?? adoptedTarget(path, name);
    this.withTarget(context, target);
    if (context.primary.provider !== "local")
      throw new RuntimeError(
        "ADOPT_LOCAL_PRIMARY_REQUIRED",
        "Adopt imports drafts into a local primary workspace",
      );
    const primary = this.provider(context.primary);
    if (!(primary instanceof LocalWorkspaceProvider))
      throw new RuntimeError("ADOPT_LOCAL_PRIMARY_REQUIRED");
    // Resolve the artifact before anything is written.
    const item = (await this.catalog(context, "instructions")).find(
      (entry) => entry.name === name,
    );
    if (item && workspaceKey(item.provider.workspace) !== workspaceKey(context.primary))
      throw new RuntimeError(
        "WORKSPACE_READ_ONLY",
        `${name} is read from a mounted workspace; adopt into an artifact of the primary workspace`,
      );
    // Sync refuses an instructions destination overlapping a skill one.
    assertNoSkillOverlap([path], await this.skillDestinations(context, project));
    // A skill holding the slug conflicts even beside a visible instructions
    // artifact of the same slug, as a legacy store may hold both.
    const holders = (await primary.list()).filter((entry) => entry.slug === name);
    const holder =
      holders.find((entry) => entry.kind === "skill") ??
      (item ? undefined : holders[0]);
    if (holder)
      throw new RuntimeError(
        "ARTIFACT_SLUG_CONFLICT",
        holder.kind === "skill"
          ? `A skill holds the slug ${name}; choose another --artifact`
          : `The instructions artifact ${name} is not visible under that name in this project; choose another --artifact`,
      );
    // The bytes get the import's checks before anything is recorded, so a
    // file that can never be imported leaves no adoption behind.
    let validated: string | null = null;
    let bytes: Uint8Array | undefined;
    try {
      bytes = readSafe(path);
    } catch {
      // Adopt refuses a missing, linked or oversized file itself.
    }
    if (bytes) {
      const request = draftRequest(
        path,
        bytes,
        { slug: name, name, description: `Adopted from ${basename(path)}` },
        "adopt-validate",
      );
      try {
        await primary.validate(request);
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError(
          "INSTRUCTIONS_INVALID",
          `${path} cannot be imported unchanged as instructions: it is empty, blank, holds NUL characters or exceeds the size limit`,
        );
      }
      validated = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    }
    const backedUp = this.projections.instructions.adopt({
      path,
      project,
      artifact: name,
      validated,
    });
    let adoption = backedUp.adoption;
    // A recorded draft that can no longer be published, because a review
    // rejected it or another version was published over its base, is
    // replaced by a fresh one against the current version.
    // So is one of another artifact than the name resolves to now, or of one
    // no longer reachable under the name at all, as when a run that recorded
    // it stopped at a workspace or alias change.
    const foreign = (
      draft: InstructionAdoption["draft"],
      resolved: CatalogEntry | undefined,
    ): boolean =>
      !!draft &&
      (workspaceKey(draft.workspace) !== workspaceKey(context.primary) ||
        resolved?.skillId !== draft.skill.id);
    const replaced =
      adoption.draft &&
      (foreign(adoption.draft, item) ||
        (await this.unpublishable(primary, adoption.draft)))
        ? adoption.draft.versionId
        : undefined;
    if (!adoption.draft || replaced)
      try {
        adoption = this.projections.instructions.recordDraft(
          adoption.id,
          adoption.nonce,
          await this.importDraft(primary, item?.skillId, adoption, backedUp.bytes),
          replaced,
        );
      } catch (error) {
        // A process that stops leaves the adoption for a re-run to finish; a
        // refusal would refuse every re-run too, so its adoption goes.
        if (backedUp.created && error instanceof RuntimeError)
          this.projections.instructions.discardAdoption(adoption);
        throw error;
      }
    // Sync's checks again, against the configuration and catalog as they are
    // after the import: the name must still resolve to the draft's artifact
    // and no skill destination may overlap the target.
    const changed = () =>
      new RuntimeError(
        "PROJECTION_CHANGED",
        `The workspaces of ${project} changed while ${path} was being adopted; run instructions adopt again`,
      );
    const latest = this.project(project);
    if (catalogFingerprint(latest) !== catalogFingerprint(context)) throw changed();
    const resolved = (await this.catalog(latest, "instructions")).find(
      (entry) => entry.name === name,
    );
    if (foreign(adoption.draft, resolved)) throw changed();
    assertNoSkillOverlap([path], await this.skillDestinations(latest, project));
    // Merged into the configuration as it is now, under the lock, so a
    // concurrent change to it is never lost.
    this.store.transaction(() => {
      const recorded = this.projections.instructions.adoption(adoption.id);
      if (recorded?.nonce !== adoption.nonce)
        throw new RuntimeError(
          "PROJECTION_CHANGED",
          `${path} was uninstalled while it was being adopted; nothing was configured`,
        );
      const current = this.project(project);
      // The recorded draft, which a concurrent run may have set, must belong
      // to the artifact the name resolved to above, under the configuration
      // those checks read.
      if (
        catalogFingerprint(current) !== catalogFingerprint(latest) ||
        JSON.stringify(current.targets) !== JSON.stringify(latest.targets) ||
        foreign(recorded.draft, resolved)
      )
        throw changed();
      const next = this.withTarget(current, target);
      if (next !== current) this.configure(project, next);
    });
    return { ...adoption, configured: target };
  }
  /** The skill destinations sync plans for the configuration's skill targets. */
  private async skillDestinations(
    context: ProjectContext,
    project: string,
  ): Promise<string[]> {
    if (context.targets.length === 0) return [];
    const catalog = await this.catalog(context);
    return context.targets.flatMap((target) =>
      catalog
        .filter((item) => !target.skills || target.skills.includes(item.name))
        .map((item) => join(targetDirectory(target, project), item.name)),
    );
  }
  /**
   * The configuration with target added, or the same object when it already
   * holds it. A different target at the same path, or one the configuration
   * checks refuse, is an error.
   */
  private withTarget(
    context: ProjectContext,
    target: InstructionTarget,
  ): ProjectContext {
    const path = instructionPath(target);
    const targets = context.instructions ?? [];
    const existing = targets.find((entry) => instructionPath(entry) === path);
    if (existing && existing.artifact !== target.artifact)
      throw new RuntimeError(
        "PROJECTION_COLLISION",
        `${path} is now configured for the instructions artifact ${existing.artifact}`,
      );
    // Sync refuses a configuration any of these checks fail, so adopt refuses
    // it before backing up or importing, for a configured target too.
    const all = existing ? targets : [...targets, target];
    const error = this.instructionConfigErrors(all).find((e) => e !== undefined);
    if (error) throw error;
    if (existing) return context;
    const next = { ...context, instructions: all };
    // The whole project schema (its target limit included), so adopt refuses
    // before it backs anything up rather than when it finally configures.
    const parsed = projectSchema.safeParse(next);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RuntimeError(
        "PROJECT_CONFIG_INVALID",
        `Adding ${path} would make skillplane.json invalid: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(),
      );
    }
    return next;
  }
  /**
   * Applies configuration removals uninstalls queued: each project drops the
   * targets at the released path. A project whose configuration is gone has
   * nothing to drop; one that cannot be read keeps its removal queued.
   */
  private applyUnconfigurations(): void {
    for (const [key] of this.projections.instructions.unconfigurations())
      try {
        this.projections.instructions.unconfigure(key, ({ path, project }) => {
          if (!existsSync(join(project, "skillplane.json"))) return;
          const context = this.project(project);
          const targets = context.instructions ?? [];
          const kept = targets.filter((target) => instructionPath(target) !== path);
          if (kept.length !== targets.length)
            this.configure(project, { ...context, instructions: kept });
        });
      } catch {
        // Retried by the next sync, adopt or uninstall.
      }
  }
  /** Whether a recorded draft was rejected or its base is no longer current. */
  private async unpublishable(
    provider: LocalWorkspaceProvider,
    draft: NonNullable<InstructionAdoption["draft"]>,
  ): Promise<boolean> {
    const row = (await provider.candidates(draft.skill.id)).find(
      (candidate) => candidate.reviewId === draft.versionId,
    );
    // Candidates exclude published versions, which stay usable.
    if (!row) return false;
    if (row.state === "rejected") return true;
    const current = await currentVersion(provider, draft.skill.id);
    return (row.base ?? null) !== (current?.version.id ?? null);
  }
  /**
   * Imports adopted bytes as a draft: a pending version that already holds
   * them, else a new draft-only artifact, another draft of an artifact with
   * nothing published, or a review candidate of a published one, even one
   * whose bytes the published version already holds. Keys are scoped to the
   * adoption and its base, so a re-adoption or a retry after the base moved
   * never replays an earlier request; the adoption's own import is recovered
   * by its nonce first, published or still publishable.
   */
  private async importDraft(
    provider: LocalWorkspaceProvider,
    skillId: string | undefined,
    adoption: InstructionAdoption,
    bytes: Uint8Array,
  ): Promise<NonNullable<InstructionAdoption["draft"]>> {
    const holds = (snapshot: Snapshot): boolean => {
      const content = snapshot.bundle.files.get(
        bundleEntrypoint(snapshot.bundle.skill),
      );
      return content !== undefined && Buffer.from(content).equals(Buffer.from(bytes));
    };
    const draft = (snapshot: Snapshot): NonNullable<InstructionAdoption["draft"]> => ({
      workspace: provider.workspace,
      skill: { id: snapshot.skill.id },
      versionId: snapshot.version.id,
      createdAt: snapshot.version.createdAt,
    });
    // Scoped to this adoption, the draft it replaces and the base it amends.
    // After an import of its own a review rejected or a publication moved
    // past, that import takes the replaced draft's place, so it never replays.
    let previous = adoption.draft?.versionId ?? "";
    const key = (base: string) =>
      `adopt-${adoption.nonce}-${createHash("sha256")
        .update(`${previous}\0${base}`)
        .digest("hex")
        .slice(0, 16)}`;
    const request = (slug: string, name: string, description: string) =>
      draftRequest(adoption.path, bytes, { slug, name, description }, key(""));
    let created: { skillId: string; versionId: string };
    if (skillId === undefined) {
      try {
        created = await provider.createDraft(
          request(
            adoption.artifact,
            adoption.artifact,
            `Adopted from ${basename(adoption.path)}`,
          ),
        );
      } catch (error) {
        if (error instanceof RuntimeError && error.code === "SKILL_SLUG_CONFLICT")
          throw new RuntimeError(
            "ARTIFACT_SLUG_CONFLICT",
            `Another artifact took the slug ${adoption.artifact}; run instructions adopt again`,
          );
        throw error;
      }
    } else {
      const current = await currentVersion(provider, skillId);
      // This adoption's own earlier import, found by its nonce whatever base it
      // amended: once a review published it, or while it can still be published
      // over the current version, it is the draft. So a run stopped after its
      // import never imports again, even once that import was approved.
      const own = provider
        .imports(`adopt-${adoption.nonce}-`)
        .filter((entry) => entry.skillId === skillId);
      previous = own[0]?.versionId ?? previous;
      for (const entry of own) {
        if (
          entry.state !== "published" &&
          (!["draft", "pending_review"].includes(entry.state) ||
            entry.base !== (current?.version.id ?? null))
        )
          continue;
        const snapshot = await provider.retrieve(skillId, entry.versionId);
        if (holds(snapshot)) return draft(snapshot);
      }
      // A draft an interrupted run created, or one awaiting review from an
      // earlier adoption, that a decision can still approve over the current
      // version.
      for (const candidate of await provider.candidates(skillId)) {
        if (
          !["draft", "pending_review"].includes(String(candidate.state)) ||
          (candidate.base ?? null) !== (current?.version.id ?? null)
        )
          continue;
        const snapshot = await provider.retrieve(skillId, String(candidate.reviewId));
        if (holds(snapshot)) return draft(snapshot);
      }
      if (current) {
        const entrypoint = bundleEntrypoint(current.bundle.skill);
        // Bytes the published version already holds still go through review
        // as a candidate of their own; adopt never takes a file over unreviewed.
        created = await provider.amend(
          {
            skillId,
            baseVersionId: current.version.id,
            proposedBump: "minor",
            idempotencyKey: key(current.version.id),
            changes: [
              {
                operation: "replace",
                path: entrypoint,
                expectedSha256: createHash("sha256")
                  .update(requireValue(current.bundle.files.get(entrypoint)))
                  .digest("hex"),
                contentBase64: Buffer.from(bytes).toString("base64"),
              },
            ],
            learning: {
              summary: `Adopt ${basename(adoption.path)}`,
              observation:
                "The user handed an existing instructions file to Skillplane",
              rationale: "Review the adopted content before it replaces the file",
              confidence: "high",
              evidence: [],
              evidenceUnavailableReason: "Imported from a local file",
              validation: [],
              validationNotRunReason: "Instructions have no executable checks",
              sourceContextId: null,
              tags: [],
              externalReferences: [],
              extra: {},
            },
          },
          { unchanged: holds(current) },
        );
      } else {
        // Nothing is published, as after a rejected draft: add another draft.
        const info = requireValue(
          (await provider.list("instructions")).find((entry) => entry.id === skillId),
        );
        created = await provider.createDraft(
          request(info.slug, info.name, info.description),
          skillId,
        );
      }
    }
    const imported = await provider.retrieve(created.skillId, created.versionId);
    if (!holds(imported))
      throw new RuntimeError(
        "ADOPT_CONTENT_MISMATCH",
        "The imported draft does not hold the file's exact bytes",
      );
    return draft(imported);
  }
  /** Restores an instructions target's previous generation. */
  rollbackInstructions(
    id: string,
    force = false,
  ): { record: InstructionRecord; backup: InstructionBackup | null } {
    this.projections.recover();
    return this.projections.instructions.rollback(id, force);
  }
  /** Restores an adopted original or removes a managed instructions file. */
  uninstallInstructions(
    id: string,
    force = false,
  ): {
    uninstalled: string;
    restored: InstructionBackup | null;
    backup: InstructionBackup | null;
  } {
    this.projections.recover();
    const result = this.projections.instructions.uninstall(id, force);
    this.applyUnconfigurations();
    return { uninstalled: id, ...result };
  }
  /** Syncs skill projections and instruction files configured by the project. */
  async syncTargets(project: string): Promise<{
    projections: ProjectionRecord[];
    instructions: InstructionRecord[];
    /** Adopted targets left as they are until their draft is published. */
    pending: PendingAdoption[];
  }> {
    this.projections.recover();
    // Read before queued removals are applied and the configuration is read,
    // so an uninstall that commits after either is never undone.
    const plan: InstructionPlan = {
      releases: this.projections.instructions.releases(),
    };
    this.applyUnconfigurations();
    const context = this.project(project);
    const catalog = await this.catalog(context);
    // Resolve and validate the catalog before any projection writes. Filesystem
    // commits are atomic per skill; interrupted batches are safely re-runnable.
    const plans = [];
    for (const target of context.targets)
      for (const item of catalog) {
        if (target.skills && !target.skills.includes(item.name)) continue;
        const selected = selectVersion(
          await item.provider.versions(item.skillId),
          target.policy,
        );
        const snapshot = await item.provider.retrieve(item.skillId, selected.id);
        assertProjectionSupported(snapshot.bundle);
        plans.push({ target, item, snapshot });
      }
    const desired = new Set<string>();
    for (const { target, item } of plans) {
      const path = join(targetDirectory(target, project), item.name);
      if (desired.has(path))
        throw new RuntimeError(
          "PROJECTION_COLLISION",
          `Duplicate target destination: ${path}`,
        );
      desired.add(path);
    }
    const resolved = await this.instructionPlans(context);
    const { pending } = resolved;
    // Writing one destination inside another would fail midway; refuse first.
    // Every configured destination counts, one awaiting adoption review too.
    assertNoSkillOverlap(
      (context.instructions ?? []).map((target) => instructionPath(target)),
      [...desired],
    );
    // An unmanaged or hand-edited instructions file, or an unsafe directory
    // above one, stops the sync before any write.
    const instructionPlans = resolved.plans.filter(
      ({ snapshot, target, published }) => {
        try {
          this.projections.instructions.check(snapshot, target, project, {
            ...plan,
            published,
          });
          return true;
        } catch (failure) {
          const set = this.pendingAdoption(target, failure, [
            "ADOPTION_PENDING_REVIEW",
            "ADOPTION_INCOMPLETE",
          ]);
          if (!set) throw failure;
          pending.push(set);
          return false;
        }
      },
    );
    const previous = this.projections.projectIds(project);
    const records = [];
    for (const { target, item, snapshot } of plans) {
      this.cache(snapshot);
      records.push(this.projections.sync(snapshot, target, project, item.name));
    }
    const installed = new Set(records.map((record) => record.id));
    for (const id of previous) {
      if (!installed.has(id) && this.store.get(`projection:${id}`))
        this.projections.uninstall(id, project);
    }
    const instructions = [];
    const claims: InstructionClaims = {
      catalog: catalogFingerprint(context),
      targets: {},
    };
    for (const { snapshot, target, published } of instructionPlans) {
      this.cache(snapshot);
      const record = this.projections.instructions.sync(snapshot, target, project, {
        ...plan,
        published,
      });
      instructions.push(record);
      claims.targets[record.id] = {
        artifact: target.artifact,
        workspace: snapshot.workspace,
        skill: { id: snapshot.skill.id },
      };
    }
    // An adoption set aside as pending keeps the identity a concurrent sync
    // recorded when it took the file over, while it agrees with what this
    // sync resolved: same catalog configuration, artifact and, where the
    // artifact resolved, the same workspace and artifact identity.
    this.store.transaction(() => {
      const stored = this.store.get<InstructionClaims>(claimsKey(project));
      if (stored?.catalog === claims.catalog)
        for (const entry of pending) {
          const kept = stored.targets[entry.id];
          const identity = resolved.plans.find(
            ({ target }) =>
              InstructionProjections.id(instructionPath(target)) === entry.id,
          )?.snapshot;
          if (
            kept?.artifact === entry.artifact &&
            (!identity ||
              (workspaceKey(kept.workspace) === workspaceKey(identity.workspace) &&
                kept.skill.id === identity.skill.id))
          )
            claims.targets[entry.id] = kept;
        }
      this.store.set(claimsKey(project), claims);
    });
    // A target dropped from this project's configuration keeps its file and
    // record; only the project's claim on it is released.
    // A configured adoption awaiting review keeps its claim too, as a
    // concurrent sync may have taken the file over since it was set aside.
    this.projections.instructions.release(
      project,
      new Set([...instructions, ...pending].map((entry) => entry.id)),
    );
    return { projections: records, instructions, pending };
  }
  async resolve(
    id: string,
    options: {
      liveOnly?: boolean;
      cacheOnly?: boolean;
      agent?: string;
    } = {},
  ): Promise<Resolution> {
    this.projections.recover();
    const record = this.projections.get(id);
    this.projections.verify(record);
    const policy = record.target.policy;
    if (options.liveOnly && options.cacheOnly)
      throw new RuntimeError("RESOLUTION_MODE_INVALID");
    if (options.cacheOnly && policy.mode === "strict-live")
      throw new RuntimeError("LIVE_REQUIRED");
    let snapshot: Snapshot | undefined;
    let source: Resolution["source"] = "live-cli";
    if (!options.cacheOnly) {
      try {
        const provider = this.provider(record.workspace, options.agent);
        const selected = selectVersion(
          await provider.versions(record.skill.id),
          policy,
        );
        snapshot = await provider.retrieve(record.skill.id, selected.id);
      } catch (error) {
        const unavailable =
          error instanceof RuntimeError &&
          [
            "CLOUD_UNAVAILABLE",
            "CREDENTIAL_UNAVAILABLE",
            "SECRET_SERVICE_UNAVAILABLE",
          ].includes(error.code);
        if (!unavailable || options.liveOnly || policy.mode === "strict-live")
          throw error;
      }
    }
    if (!snapshot) {
      source = "cached-cli";
      const candidates = this.store
        .entries<CachedSnapshot>(
          `cache:${workspaceKey(record.workspace)}:${record.skill.id}:`,
        )
        .map(([, s]) => s);
      candidates.push({
        workspace: record.workspace,
        skill: record.skill,
        version: record.version,
        digest: record.digest,
      });
      while (candidates.length) {
        const selected = selectVersion(
          candidates.map((c) => c.version),
          policy,
        );
        const index = candidates.findIndex((c) => c.version.id === selected.id);
        const cached = requireValue(candidates.splice(index, 1)[0]);
        try {
          snapshot = {
            workspace: cached.workspace,
            skill: cached.skill,
            version: cached.version,
            bundle: await this.store.bundle(cached.digest),
          };
          break;
        } catch (error) {
          if (policy.mode === "pinned") throw error;
        }
      }
      if (!snapshot)
        throw new RuntimeError(
          "VERSION_UNAVAILABLE",
          "No intact cached version is available",
        );
    }
    if (
      workspaceKey(snapshot.workspace) !== workspaceKey(record.workspace) ||
      snapshot.skill.id !== record.skill.id ||
      snapshot.bundle.digest !== snapshot.version.digest ||
      snapshot.version.state !== "published"
    )
      throw new RuntimeError("SNAPSHOT_IDENTITY_MISMATCH");
    assertProjectionSupported(snapshot.bundle);
    const trust = trustEnvelope(snapshot.bundle);
    // Even approved frontmatter changes must first be installed by sync, because
    // the current host already parsed the old projection metadata.
    if (trustExpands(record.trust, trust)) {
      this.store.set(`pending-trust:${id}`, {
        digest: snapshot.bundle.digest,
        trust,
        source: workspaceKey(snapshot.workspace),
        skillId: snapshot.skill.id,
      });
      throw new RuntimeError(
        "TRUST_APPROVAL_REQUIRED",
        `Review ${id} at digest ${snapshot.bundle.digest}, approve it, then sync before invoking`,
      );
    }
    this.cache(snapshot);
    const same = snapshot.bundle.digest === record.digest;
    if (!same)
      this.store.set(`refresh:${id}`, {
        versionId: snapshot.version.id,
        digest: snapshot.bundle.digest,
      });
    const freshness =
      policy.mode === "pinned"
        ? "pinned"
        : source === "live-cli"
          ? "verified"
          : "unverified";
    let resourceDirectory: string | undefined;
    if (!same) {
      resourceDirectory = safeDirectory(
        join(this.store.root, "resolved", snapshot.bundle.digest.slice(7)),
      );
      for (const [path, bytes] of snapshot.bundle.files)
        writeAtomic(join(resourceDirectory, path), bytes);
    }
    this.store.transaction(() => {
      for (const type of ["skill_resolved", "skill_invoked_observed"] as const)
        this.usage.record({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          type,
          workspace: workspaceKey(record.workspace),
          skillId: record.skill.id,
          versionId: requireValue(snapshot).version.id,
          projectionId: id,
          installationId: record.installationId,
          agent: options.agent ?? "unknown",
          model: "unknown",
          modelTrust: "caller-declared",
          sessionId: null,
          delivery: source,
          freshness,
          confidence: "observed",
          evidence: null,
        });
    });
    return {
      source,
      freshness,
      version: snapshot.version,
      useEmbedded: same,
      ...(same
        ? {}
        : {
            instructions: new TextDecoder().decode(
              snapshot.bundle.files.get("SKILL.md"),
            ),
            resourceDirectory: requireValue(resourceDirectory),
          }),
      refreshScheduled: !same,
      disclosure:
        source === "cached-cli"
          ? "Cached exact version; freshness is unverified. This CLI invocation was observed locally."
          : "Exact version checked with the authoritative workspace. Observed invocation; success is not inferred.",
    };
  }
  /**
   * Caches a retrieved snapshot and records skill usage for it. Instructions
   * documents are cached too, but they are not skills, so they never count as
   * skill usage locally or in a cloud upload.
   */
  observeRead(snapshot: Snapshot, agent: string, invoked = false): void {
    this.cache(snapshot);
    if (bundleKind(snapshot.bundle.skill) !== "skill") return;
    const types = invoked
      ? (["skill_resolved", "skill_invoked_observed"] as const)
      : (["skill_resolved"] as const);
    this.store.transaction(() => {
      for (const type of types)
        this.usage.record({
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          type,
          workspace: workspaceKey(snapshot.workspace),
          skillId: snapshot.skill.id,
          versionId: snapshot.version.id,
          projectionId: null,
          installationId: requireValue(this.store.get<string>("installation")),
          agent,
          model: "unknown",
          modelTrust: "caller-declared",
          sessionId: null,
          delivery: "live-cli",
          freshness: "verified",
          confidence: "observed",
          evidence: null,
        });
    });
  }
  async doctor(checkCloud = false, project?: string): Promise<unknown> {
    const recovery = this.projections.recover();
    // A recovered uninstall's target leaves its project's configuration first.
    this.applyUnconfigurations();
    const projections = [];
    for (const [, record] of this.store.entries<ProjectionRecord>("projection:")) {
      let health = "healthy";
      try {
        this.projections.verify(record);
        await this.store.bundle(record.digest);
      } catch (e) {
        health = e instanceof RuntimeError ? e.code : "MISSING_PROJECTION";
      }
      if (checkCloud && health === "healthy") {
        try {
          const versions = await this.provider(record.workspace).versions(
            record.skill.id,
          );
          if (selectVersion(versions, record.target.policy).digest !== record.digest)
            health = "STALE_PROJECTION";
        } catch (e) {
          health = e instanceof RuntimeError ? e.code : "CLOUD_UNAVAILABLE";
        }
      }
      projections.push({
        id: record.id,
        name: record.name,
        path: record.path,
        version: record.version,
        health,
        refreshPending: Boolean(this.store.get(`refresh:${record.id}`)),
      });
    }
    let context: ProjectContext | undefined;
    if (project)
      try {
        context = this.project(project);
      } catch {
        // projectStatus reports an unreadable project configuration.
      }
    return {
      recovery,
      projections,
      instructions: this.projections.instructions.status(
        project && context
          ? {
              project,
              targets: await this.instructionResolutions(project, context, checkCloud),
            }
          : undefined,
      ),
      pendingTrust: this.store.entries("pending-trust:"),
      usage: this.usage.report(),
      cloudChecked: checkCloud,
      cliAvailable: (process.env.PATH ?? "")
        .split(process.platform === "win32" ? ";" : ":")
        .some((directory) =>
          (process.platform === "win32"
            ? ["skillplane.cmd", "skillplane.ps1", "skillplane"]
            : ["skillplane"]
          ).some((name) => existsSync(join(directory, name))),
        ),
      projectStatus: project
        ? await this.projectHealth(project, checkCloud)
        : "not-checked",
    };
  }
  private async projectHealth(project: string, online: boolean): Promise<string> {
    try {
      const context = this.project(project);
      if (
        !online &&
        [context.primary, ...context.mounts.map((m) => m.workspace)].some(
          (w) => w.provider === "cloud",
        )
      )
        return "valid-cloud-catalog-unchecked";
      await this.catalog(context);
      return "healthy";
    } catch (error) {
      return error instanceof RuntimeError
        ? error.code
        : "PROJECT_CONFIGURATION_INVALID";
    }
  }
  async importBundle(
    context: ProjectContext,
    bytes: Uint8Array,
    key: string,
  ): Promise<unknown> {
    const bundle = await canonicalizeBundle(bytes);
    const kind = bundleKind(bundle.skill);
    const entrypoint = bundleEntrypoint(bundle.skill);
    return this.create(context, {
      ...(kind === "instructions" ? { kind } : {}),
      ...(bundle.skill.formatVersion === 2
        ? {
            composition: {
              dependencies: bundle.skill.dependencies,
              verify: Boolean(bundle.skill.entrypoints.verify),
              blocking: bundle.skill.verification?.blocking ?? false,
            },
          }
        : {}),
      slug: bundle.skill.slug,
      name: bundle.skill.name,
      description: bundle.skill.description,
      tags: bundle.skill.tags,
      visibility: "private",
      instructions: new TextDecoder().decode(bundle.files.get(entrypoint)),
      assets: [...bundle.files]
        .filter(
          ([p]) =>
            ![
              entrypoint,
              "skill.json",
              ...(bundle.skill.formatVersion === 2 ? ["skill.lock.json"] : []),
            ].includes(p),
        )
        .map(([path, content]) => ({
          path,
          contentBase64: Buffer.from(content).toString("base64"),
        })),
      idempotencyKey: key,
    });
  }
  exportBundle(snapshot: Snapshot, path: string): void {
    if (existsSync(path)) throw new RuntimeError("EXPORT_EXISTS");
    writeAtomic(path, snapshot.bundle.bytes);
  }
}
