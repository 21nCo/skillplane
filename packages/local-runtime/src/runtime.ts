import { requireValue } from "./contracts.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalizeBundle } from "@skillplane/storage";
import { type LocalStore } from "./store.js";
import { Profiles } from "./profiles.js";
import { LocalWorkspaceProvider } from "./local-provider.js";
import { CloudWorkspaceProvider } from "./cloud-provider.js";
import { Projections, type ProjectionRecord } from "./projections.js";
import { UsageQueue } from "./analytics.js";
import { readSafe, writeAtomic, safeDirectory } from "./files.js";
import { trustEnvelope, trustExpands } from "./trust.js";
import {
  projectSchema,
  selectVersion,
  workspaceKey,
  RuntimeError,
  declaredCaller,
  type ProjectContext,
  type WorkspaceRef,
  type WorkspaceProvider,
  type Snapshot,
  type CreateRequest,
  type AmendRequest,
} from "./contracts.js";
type CachedSnapshot = Omit<Snapshot, "bundle"> & {
  digest: string;
};
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
  async catalog(context: ProjectContext): Promise<
    {
      name: string;
      provider: WorkspaceProvider;
      skillId: string;
    }[]
  > {
    context = projectSchema.parse(context);
    const sources = [
      { workspace: context.primary, namespace: undefined },
      ...context.mounts,
    ];
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
      for (const skill of await provider.list()) {
        const qualified = `${workspaceKey(source.workspace)}/${skill.id}`;
        const name =
          context.aliases[qualified] ??
          (source.namespace ? `${source.namespace}-${skill.slug}` : skill.slug);
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
    this.projections.recover();
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
        plans.push({ target, item, snapshot });
      }
    const records = [];
    for (const { target, item, snapshot } of plans) {
      this.cache(snapshot);
      records.push(this.projections.sync(snapshot, target, project, item.name));
    }
    return records;
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
      const selected = selectVersion(
        candidates.map((c) => c.version),
        policy,
      );
      const cached = requireValue(candidates.find((c) => c.version.id === selected.id));
      snapshot = {
        workspace: cached.workspace,
        skill: cached.skill,
        version: cached.version,
        bundle: await this.store.bundle(cached.digest),
      };
    }
    if (
      workspaceKey(snapshot.workspace) !== workspaceKey(record.workspace) ||
      snapshot.skill.id !== record.skill.id ||
      snapshot.bundle.digest !== snapshot.version.digest ||
      snapshot.version.state !== "published"
    )
      throw new RuntimeError("SNAPSHOT_IDENTITY_MISMATCH");
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
    let resourceDirectory: string | undefined;
    if (!same) {
      resourceDirectory = safeDirectory(
        join(this.store.root, "resolved", snapshot.bundle.digest.slice(7)),
      );
      for (const [path, bytes] of snapshot.bundle.files)
        writeAtomic(join(resourceDirectory, path), bytes);
    }
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
  observeRead(snapshot: Snapshot, agent: string, invoked = false): void {
    this.cache(snapshot);
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
    return {
      recovery,
      projections,
      pendingTrust: this.store.entries("pending-trust:"),
      usage: this.usage.report(),
      cloudChecked: checkCloud,
      cliAvailable: (process.env.PATH ?? "")
        .split(process.platform === "win32" ? ";" : ":")
        .some((directory) => existsSync(join(directory, "skillplane"))),
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
    return this.create(context, {
      slug: bundle.skill.slug,
      name: bundle.skill.name,
      description: bundle.skill.description,
      tags: bundle.skill.tags,
      visibility: "private",
      instructions: new TextDecoder().decode(bundle.files.get("SKILL.md")),
      assets: [...bundle.files]
        .filter(([p]) => !["SKILL.md", "skill.json"].includes(p))
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
