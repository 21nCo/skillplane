import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import {
  canonicalizeBundleFiles,
  R2BundleRepository,
  type R2BucketLike,
  type SkillDependency,
} from "@skillplane/storage";
import { SkillService } from "../../src/skills.js";
import { SkillVersionService } from "../../src/skill-versions.js";
import { PublicationService } from "../../src/publication.js";
import { CompositionService } from "../../src/composition-service.js";
import { VerificationService } from "../../src/verification.js";
import { VersionLifecycleService } from "../../src/version-lifecycle.js";
import { seedTenantFixture } from "../../../testing/src/fixtures.js";
import type { Principal } from "../../src/principal.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "composition lifecycle with Postgres and content-addressed storage",
  () => {
    const pool = new Pool({ connectionString: url, max: 5 });
    const records = new Map<
      string,
      { bytes: Uint8Array; metadata: Readonly<Record<string, string>> }
    >();
    const bucket: R2BucketLike = {
      async head(key) {
        const r = records.get(key);
        return r
          ? { key, size: r.bytes.length, etag: key, customMetadata: r.metadata }
          : null;
      },
      async get(key) {
        const r = records.get(key);
        return r
          ? {
              key,
              size: r.bytes.length,
              etag: key,
              customMetadata: r.metadata,
              async arrayBuffer() {
                return r.bytes.slice().buffer;
              },
            }
          : null;
      },
      async put(key, bytes, options) {
        if (records.has(key) && options?.onlyIf?.etagDoesNotMatch === "*") return null;
        records.set(key, {
          bytes: bytes.slice(),
          metadata: options?.customMetadata ?? {},
        });
        return { key, size: bytes.length, etag: key };
      },
      async delete(keys) {
        for (const k of typeof keys === "string" ? [keys] : keys) records.delete(k);
      },
      async list() {
        return { objects: [], truncated: false };
      },
    };
    const storage = new R2BundleRepository(bucket),
      composition = new CompositionService(pool, storage);
    const skills = new SkillService(pool, storage, pool, composition),
      versions = new SkillVersionService(
        pool,
        storage,
        skills.idempotency,
        composition,
      ),
      publication = new PublicationService(
        pool,
        storage,
        skills.idempotency,
        composition,
      ),
      verification = new VerificationService(pool, composition, skills.idempotency),
      lifecycle = new VersionLifecycleService(pool, pool, skills.idempotency);
    let principal: Principal, foreign: Principal, workspaceSlug: string;
    const mutation = () => ({
      principal,
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
    });
    const claim = {
      id: "datafn.read-surfaces",
      statement: "Every read surface uses DataFn",
      severity: "blocking",
      scope: "All application reads and mutations",
      requiredEvidence: ["surface-inventory", "bypass-scan", "runtime-traces"],
      prohibitedBypasses: ["direct SQL"],
      rules: {
        pass: "Every surface traced through DataFn",
        fail: "A bypass exists",
        unknown: "Any unaccounted surface",
      },
    };
    const dependency = (slug: string): SkillDependency => ({
      alias: slug,
      workspace: workspaceSlug,
      skill: slug,
      version: "^1.0.0",
      scope: "execution",
      mode: "invoke",
      required: true,
    });
    async function bundle(
      slug: string,
      deps: SkillDependency[] = [],
      text = "Instructions",
      withClaims = false,
      spoof = false,
    ) {
      const files = new Map([["SKILL.md", new TextEncoder().encode(text)]]);
      if (withClaims) {
        files.set(
          "verification/VERIFY.md",
          new TextEncoder().encode(
            "Independently inventory, trace and test every surface.",
          ),
        );
        files.set(
          "verification/claims.json",
          new TextEncoder().encode(JSON.stringify([claim])),
        );
      }
      if (spoof)
        files.set("skill.lock.json", new TextEncoder().encode('{"forged":true}'));
      return canonicalizeBundleFiles({
        skill: {
          formatVersion: 2,
          name: slug,
          slug,
          description: "",
          tags: [],
          entrypoints: {
            execute: "SKILL.md",
            ...(withClaims ? { verify: "verification/VERIFY.md" as const } : {}),
          },
          dependencies: deps,
          ...(withClaims
            ? {
                verification: {
                  claims: "verification/claims.json" as const,
                  blocking: true,
                },
              }
            : {}),
        },
        files,
      });
    }
    const create = async (
      slug: string,
      deps: SkillDependency[] = [],
      withClaims = false,
      visibility: "private" | "workspace" | "public" = "private",
    ) =>
      skills.create({
        ...mutation(),
        workspaceId: principal.workspaceId,
        archiveBytes: (await bundle(slug, deps, "Instructions", withClaims, true))
          .bytes,
        visibility,
      });
    beforeAll(async () => {
      const suffix = `ski3-${crypto.randomUUID().slice(0, 8)}`;
      const fixture = await seedTenantFixture(url ?? "", suffix);
      const other = await seedTenantFixture(url ?? "", `${suffix}-other`);
      workspaceSlug = `workspace-${suffix}`;
      principal = {
        kind: "user",
        actorId: fixture.userId,
        userId: fixture.userId,
        sessionId: "session-test",
        workspaceId: fixture.workspaceId,
        role: "owner",
      };
      foreign = {
        ...principal,
        actorId: other.userId,
        userId: other.userId,
        workspaceId: other.workspaceId,
      };
    }, 30000);
    afterAll(async () => pool.end());
    it("creates a server lock, persists normalized edges and inherits execution child claims", async () => {
      const child = await create("datafn", [], true);
      const parent = await create("company-stack", [dependency("datafn")]);
      const plan = await composition.resolve(parent.version.id, principal);
      expect(plan.dag.nodes.map((n) => n.versionId)).toEqual([child.version.id]);
      expect(plan.executionPlan.invocations[0]?.alias).toBe("datafn");
      expect(plan.verificationPlan.claims[0]?.originatingVersionId).toBe(
        child.version.id,
      );
      expect(
        (await composition.resolve(parent.version.id, principal, "verify"))
          .executionPlan.modules,
      ).toEqual([]);
      const normalized = await pool.query(
        "SELECT * FROM skill_version_dependencies WHERE root_version_id=$1",
        [parent.version.id],
      );
      expect(normalized.rowCount).toBe(1);
      await expect(
        pool.query(
          "UPDATE skill_version_compositions SET format_version=2 WHERE version_id=$1",
          [parent.version.id],
        ),
      ).rejects.toThrow("immutable");
      await expect(composition.resolve(parent.version.id, foreign)).rejects.toThrow(
        "inaccessible",
      );
    });
    it("keeps published and candidate locks pinned across concurrent child publication", async () => {
      const child = await create("up-child");
      const parent = await create("up-parent", [dependency("up-child")]);
      const original = await composition.resolve(parent.version.id, principal);
      const childCandidate = await versions.createCandidate({
        ...mutation(),
        skillId: child.skill.id,
        baseVersionId: child.version.id,
        proposedBump: "minor",
        changeSummary: "New child",
        archiveBytes: (await bundle("up-child", [], "New child guidance")).bytes,
      });
      const updated = await publication.publish({
        ...mutation(),
        skillId: child.skill.id,
        candidateVersionId: childCandidate.id,
      });
      expect(
        (await composition.resolve(parent.version.id, principal)).closureDigest,
      ).toBe(original.closureDigest);
      expect(
        (await composition.upgradePreview(parent.version.id, principal)).available,
      ).toBe(true);
      const candidate = await versions.createCandidate({
        ...mutation(),
        skillId: parent.skill.id,
        baseVersionId: parent.version.id,
        proposedBump: "minor",
        changeSummary: "Upgrade",
        archiveBytes: (
          await storage.getCanonicalBundle(
            parent.version.objectKey,
            parent.version.digest,
          )
        ).bytes,
      });
      expect(
        (await composition.resolve(candidate.id, principal, "execute", true)).dag
          .nodes[0]?.versionId,
      ).toBe(updated.id);
      const childNext = await versions.createCandidate({
        ...mutation(),
        skillId: child.skill.id,
        baseVersionId: updated.id,
        proposedBump: "minor",
        changeSummary: "Another child",
        archiveBytes: (await bundle("up-child", [], "Third child guidance")).bytes,
      });
      await publication.publish({
        ...mutation(),
        skillId: child.skill.id,
        candidateVersionId: childNext.id,
      });
      await publication.publish({
        ...mutation(),
        skillId: parent.skill.id,
        candidateVersionId: candidate.id,
      });
      expect(
        (await composition.resolve(candidate.id, principal)).dag.nodes[0]?.versionId,
      ).toBe(updated.id);
      await lifecycle.set({
        ...mutation(),
        skillId: child.skill.id,
        versionId: updated.id,
        state: "revoked",
        reason: "Replace unsafe dependency",
      });
      await expect(
        versions.retrieveBundle({
          skillId: parent.skill.id,
          versionId: candidate.id,
          principal,
        }),
      ).rejects.toThrow("revoked");
      const repairBundle = await composition.upgradeBundle(
        candidate.id,
        parent.skill.id,
        principal,
      );
      expect(
        (await composition.upgradePreview(candidate.id, principal, parent.skill.id))
          .available,
      ).toBe(true);
      const repair = await versions.createCandidate({
        ...mutation(),
        skillId: parent.skill.id,
        baseVersionId: candidate.id,
        proposedBump: "minor",
        changeSummary: "Replace revoked pin",
        archiveBytes: repairBundle.bytes,
      });
      expect(
        (await composition.resolve(repair.id, principal, "execute", true)).dag.nodes[0]
          ?.versionId,
      ).toBe(childNext.id);
    });
    it("rejects visibility widening and private cross-workspace references", async () => {
      await create("private-child");
      await expect(
        create("public-parent", [dependency("private-child")], false, "public"),
      ).rejects.toThrow("inaccessible");
      const foreignCreate = await skills.create({
        principal: foreign,
        idempotencyKey: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
        workspaceId: foreign.workspaceId,
        archiveBytes: (await bundle("foreign-child")).bytes,
        visibility: "private",
      });
      const result = await pool.query<{ slug: string }>(
        "SELECT slug FROM workspaces WHERE id=$1",
        [foreign.workspaceId],
      );
      await expect(
        create("foreign-parent", [
          {
            ...dependency(foreignCreate.skill.slug),
            workspace: result.rows[0]?.slug ?? "missing",
          },
        ]),
      ).rejects.toThrow();
    });
    it("fails incomplete verification, requires every evidence type, and freezes completion", async () => {
      const root = await create("verified", [], true);
      const input = {
        ...mutation(),
        versionId: root.version.id,
        repository: "https://example.test/repository",
        commit: "a".repeat(40),
        environment: "test",
        executorActorId: "executor:separate",
        agent: "Verifier",
        model: "test",
      };
      const first = await verification.start(input);
      expect((await verification.start(input)).id).toBe(first.id);
      expect(
        (await verification.complete({ ...mutation(), runId: first.id })).status,
      ).toBe("unknown");
      const run = await verification.start({
        ...input,
        idempotencyKey: crypto.randomUUID(),
      });
      const claimId = run.plan.claims[0]?.namespacedId ?? "missing";
      await expect(
        verification.addEvidence({
          ...mutation(),
          runId: run.id,
          result: {
            claimId,
            status: "pass",
            explanation: "Only installed package",
            evidence: [],
          },
        }),
      ).rejects.toThrow("every declared evidence type");
      const evidence = claim.requiredEvidence.map((type) => ({
        type,
        uri: "https://evidence.example.test/redacted",
        sha256: "b".repeat(64),
        description: type,
        redacted: true as const,
      }));
      await verification.addEvidence({
        ...mutation(),
        runId: run.id,
        result: {
          claimId,
          status: "pass",
          explanation: "Every surface independently traced",
          evidence,
        },
      });
      const completed = await verification.complete({ ...mutation(), runId: run.id });
      expect(completed.status).toBe("pass");
      expect(completed.evidence_manifest_digest).toMatch(/^sha256:/);
      await expect(
        verification.addEvidence({
          ...mutation(),
          runId: run.id,
          result: { claimId, status: "fail", explanation: "Changed", evidence: [] },
        }),
      ).rejects.toThrow("running attestation");
      await expect(verification.get(run.id, foreign)).rejects.toThrow("not found");
      await expect(
        verification.start({
          ...input,
          executorActorId: principal.actorId,
          idempotencyKey: crypto.randomUUID(),
        }),
      ).rejects.toThrow("different executor");
    });
    it("preserves deprecated pins and fails revoked retrieval and publication closed", async () => {
      const child = await create("revoke-child"),
        parent = await create("revoke-parent", [dependency("revoke-child")]);
      const candidate = await versions.createCandidate({
        ...mutation(),
        skillId: parent.skill.id,
        baseVersionId: parent.version.id,
        proposedBump: "patch",
        changeSummary: "Updated parent",
        archiveBytes: (
          await bundle("revoke-parent", [dependency("revoke-child")], "Updated parent")
        ).bytes,
      });
      await lifecycle.set({
        ...mutation(),
        skillId: child.skill.id,
        versionId: child.version.id,
        state: "deprecated",
        reason: "Use newer guidance",
      });
      expect(
        (await composition.resolve(parent.version.id, principal)).warnings,
      ).toHaveLength(1);
      await lifecycle.set({
        ...mutation(),
        skillId: child.skill.id,
        versionId: child.version.id,
        state: "revoked",
        reason: "Unsafe guidance",
      });
      await expect(composition.resolve(parent.version.id, principal)).rejects.toThrow(
        "revoked",
      );
      await expect(
        publication.publish({
          ...mutation(),
          skillId: parent.skill.id,
          candidateVersionId: candidate.id,
        }),
      ).rejects.toThrow("revoked");
      const status = await pool.query("SELECT status FROM skill_versions WHERE id=$1", [
        candidate.id,
      ]);
      expect(status.rows[0].status).toBe("pending_review");
      await expect(
        skills.setVisibility({
          ...mutation(),
          skillId: parent.skill.id,
          visibility: "private",
        }),
      ).resolves.toMatchObject({ visibility: "private" });
    });
    it("serves public closures without regional tables and rejects delayed stale public projections after withdrawal", async () => {
      const child = await create("public-data", [], true, "public");
      const parent = await create(
        "public-stack",
        [dependency("public-data")],
        false,
        "public",
      );
      for (const resource of [child, parent]) {
        await pool.query(
          `INSERT INTO public_skill_projections (workspace_id,workspace_slug,skill_id,skill_slug,version_id,semantic_version,digest,object_key,document,projection_sequence) VALUES ($1,$2,$3,$4,$5,'1.0.0',$6,$7,$8,1)`,
          [
            principal.workspaceId,
            workspaceSlug,
            resource.skill.id,
            resource.skill.slug,
            resource.version.id,
            resource.version.digest,
            resource.version.objectKey,
            { skill: resource.skill, version: resource.version },
          ],
        );
        await pool.query(
          `INSERT INTO public_skill_projection_heads (workspace_id,skill_id,current_version_id,state,projection_sequence) VALUES ($1,$2,$3,'published',1)`,
          [principal.workspaceId, resource.skill.id, resource.version.id],
        );
      }
      const publicOnly = new CompositionService(
        {
          query: async () => {
            throw new Error("Regional access forbidden");
          },
        } as unknown as Pool,
        storage,
        pool,
        storage,
        true,
      );
      expect(
        (await publicOnly.resolve(parent.version.id, null)).verificationPlan.claims,
      ).toHaveLength(1);
      await skills.setVisibility({
        ...mutation(),
        skillId: child.skill.id,
        visibility: "private",
      });
      // A delayed old event can update processing time, but cannot advance its causal sequence.
      await pool.query(
        "UPDATE public_skill_projections SET updated_at=clock_timestamp() WHERE version_id=$1",
        [child.version.id],
      );
      await expect(publicOnly.resolve(parent.version.id, null)).rejects.toThrow(
        "inaccessible",
      );
      await expect(composition.resolve(parent.version.id, null)).rejects.toThrow(
        "inaccessible",
      );
    });
    it("retains v2 reads while the composition write switch is disabled", async () => {
      const root = await create("reader-rollout");
      const readers = new CompositionService(
        pool,
        storage,
        pool,
        storage,
        false,
        false,
      );
      expect((await readers.resolve(root.version.id, principal)).root.versionId).toBe(
        root.version.id,
      );
      await expect(
        readers.prepare(await bundle("writer-disabled"), principal, "private"),
      ).rejects.toThrow("writes are disabled");
    });
    it("purges only expired attestations using the active workspace migration epoch", async () => {
      const root = await create("retention-root", [], true);
      const run = await verification.start({
        ...mutation(),
        versionId: root.version.id,
        repository: "https://example.com/repo",
        commit: "a".repeat(40),
        environment: "test",
        executorActorId: "executor:other",
        agent: "verifier",
        model: "test",
      });
      const expiredId = `verification:${crypto.randomUUID()}`;
      await pool.query(
        `INSERT INTO skill_verification_runs (workspace_id,id,version_id,closure_digest,repository,commit_sha,environment,verifier_actor_id,verifier_actor_type,executor_actor_id,agent,model,plan,expires_at) SELECT workspace_id,$2,version_id,closure_digest,repository,commit_sha,environment,verifier_actor_id,verifier_actor_type,executor_actor_id,agent,model,plan,now()-interval '1 second' FROM skill_verification_runs WHERE id=$1`,
        [run.id, expiredId],
      );
      await pool.query(
        "UPDATE regional_workspace_migration_fences SET active_epoch=2 WHERE workspace_id=$1",
        [principal.workspaceId],
      );
      const output = execFileSync(
        process.execPath,
        [
          fileURLToPath(
            new URL("../../../../scripts/verification-retention.mjs", import.meta.url),
          ),
        ],
        { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toMatchObject({
        event: "verification.retention",
        deletedRuns: 1,
      });
      expect(
        (
          await pool.query("SELECT id FROM skill_verification_runs WHERE id=$1", [
            run.id,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await pool.query("SELECT id FROM skill_verification_runs WHERE id=$1", [
            expiredId,
          ])
        ).rowCount,
      ).toBe(0);
    });
  },
);
