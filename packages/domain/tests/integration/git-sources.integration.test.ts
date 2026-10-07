import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { migrateDatabase } from "../../../db/src/migrate.js";
import { seedTenantFixture } from "../../../testing/src/fixtures.js";
import { createSkillBundleFixture } from "../../../testing/src/skill-bundles.js";
import { TestObjectStorage } from "../../../testing/src/runtime.js";
import { canonicalizeBundle, R2BundleRepository } from "@skillplane/storage";
import { IdempotencyStore } from "../../src/idempotency.js";
import { SkillService } from "../../src/skills.js";
import { SkillVersionService } from "../../src/skill-versions.js";
import { GitSourceService } from "../../src/git-sources.js";
import type { GitSnapshot } from "../../src/git-source-provider.js";
import type { Principal } from "../../src/principal.js";
const url = process.env.TEST_DATABASE_URL ?? "";
describe.skipIf(!url)("Git source persistence and recovery", () => {
  const pool = new Pool({ connectionString: url, max: 4 }),
    objects = new TestObjectStorage(),
    storage = new R2BundleRepository(objects),
    skills = new SkillService(pool, storage),
    versions = new SkillVersionService(pool, storage, new IdempotencyStore(pool));
  let snapshot: GitSnapshot = { commitSha: "a".repeat(40), skills: [] },
    failProvider = false;
  const provider = {
    snapshot: async (_config: unknown, commit?: string) => {
      if (failProvider) throw new Error("provider unavailable");
      expect(commit ?? snapshot.commitSha).toBe(snapshot.commitSha);
      return snapshot;
    },
  };
  const sources = new GitSourceService(pool, skills, versions, provider);
  let owner: Principal, other: Principal;
  const m = () => ({
    principal: owner,
    requestId: crypto.randomUUID(),
    fencingEpoch: 1,
  });
  const bundle = async (slug: string, content: string) =>
    canonicalizeBundle(
      await createSkillBundleFixture({
        name: slug,
        slug,
        description: "Review workflows",
        tags: ["review"],
        skillMarkdown: content,
      }),
    );
  beforeAll(async () => {
    await migrateDatabase(url);
    const a = await seedTenantFixture(url, `git-a-${crypto.randomUUID()}`),
      b = await seedTenantFixture(url, `git-b-${crypto.randomUUID()}`);
    owner = {
      kind: "user",
      role: "owner",
      actorId: a.userId,
      userId: a.userId,
      sessionId: "s",
      workspaceId: a.workspaceId,
    };
    other = {
      ...owner,
      userId: b.userId,
      actorId: b.userId,
      workspaceId: b.workspaceId,
    };
  }, 60000);
  afterAll(() => pool.end());
  it("imports privately, stores immutable provenance and creates reviewable updates without duplicate versions", async () => {
    const key = crypto.randomUUID(),
      config = { repositoryUrl: "https://github.com/a/b", ref: "main" };
    const s = await sources.create({ ...m(), config, idempotencyKey: key });
    expect((await sources.create({ ...m(), config, idempotencyKey: key })).id).toBe(
      s.id,
    );
    await expect(sources.get(other, s.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    snapshot = {
      commitSha: "a".repeat(40),
      skills: [
        {
          path: "skills/review",
          bundle: await bundle("git-review", "# Review\nInspect evidence."),
          error: null,
        },
      ],
    };
    const preview = await sources.preview({ ...m(), sourceId: s.id });
    expect(preview.plan[0]?.action).toBe("added");
    expect((await sources.get(owner, s.id)).bindings).toHaveLength(0);
    const applied = await sources.apply({ ...m(), sourceId: s.id, runId: preview.id });
    expect(applied.results[0]?.status).toBe("imported");
    const skillId = applied.results[0]?.skillId ?? "",
      versionId = applied.results[0]?.versionId ?? "";
    expect((await skills.get({ skillId, principal: owner })).visibility).toBe(
      "private",
    );
    expect((await versions.get({ skillId, versionId, principal: owner })).source).toBe(
      "import",
    );
    expect(await sources.provenance(owner, versionId)).toMatchObject({
      commit_sha: "a".repeat(40),
      skill_path: "skills/review",
    });
    await expect(
      pool.query(
        "UPDATE skill_version_git_provenance SET commit_sha=$2 WHERE version_id=$1",
        [versionId, "b".repeat(40)],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    expect(
      (await sources.apply({ ...m(), sourceId: s.id, runId: preview.id })).results,
    ).toEqual(applied.results);
    snapshot = { ...snapshot, commitSha: "b".repeat(40) };
    const noop = await sources.preview({ ...m(), sourceId: s.id });
    expect(noop.plan[0]?.action).toBe("unchanged");
    await sources.apply({ ...m(), sourceId: s.id, runId: noop.id });
    expect(
      (await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [skillId]))
        .rowCount,
    ).toBe(1);
    snapshot = {
      commitSha: "c".repeat(40),
      skills: [
        {
          path: "skills/review",
          bundle: await bundle(
            "git-review",
            "# Review\nInspect authorization and evidence.",
          ),
          error: null,
        },
      ],
    };
    const changed = await sources.preview({ ...m(), sourceId: s.id });
    expect(changed.plan[0]?.action).toBe("changed");
    const pending = await sources.apply({ ...m(), sourceId: s.id, runId: changed.id });
    expect(pending.results[0]?.status).toBe("pending_review");
    expect(
      (await skills.get({ skillId, principal: owner })).currentPublishedVersionId,
    ).toBe(versionId);
    expect(
      (
        await versions.get({
          skillId,
          versionId: pending.results[0]?.versionId ?? "",
          principal: owner,
        })
      ).status,
    ).toBe("pending_review");
    snapshot = { commitSha: "d".repeat(40), skills: [] };
    const missing = await sources.preview({ ...m(), sourceId: s.id });
    expect(missing.plan[0]?.action).toBe("missing");
    await sources.apply({ ...m(), sourceId: s.id, runId: missing.id });
    expect((await skills.get({ skillId, principal: owner })).archivedAt).toBeNull();
    const current = (await sources.get(owner, s.id)).source;
    await sources.update({
      ...m(),
      sourceId: s.id,
      expectedRevision: current.revision,
      config: { ...config },
      archived: true,
    });
    await expect(sources.preview({ ...m(), sourceId: s.id })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await sources.provenance(owner, versionId)).not.toBeNull();
  });
  it("retries partial storage failures and recovers a committed version after binding persistence fails", async () => {
    const s = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/recovery" },
      idempotencyKey: crypto.randomUUID(),
    });
    snapshot = {
      commitSha: "e".repeat(40),
      skills: [
        {
          path: "one",
          bundle: await bundle("recover-one", "# One\nReview."),
          error: null,
        },
        {
          path: "two",
          bundle: await bundle("recover-two", "# Two\nReview."),
          error: null,
        },
      ],
    };
    const preview = await sources.preview({ ...m(), sourceId: s.id });
    objects.failNextPut = true;
    const partial = await sources.apply({ ...m(), sourceId: s.id, runId: preview.id });
    expect(partial.status).toBe("partial");
    expect(partial.results.map((r) => r.status)).toEqual(["error", "imported"]);
    const final = await sources.apply({ ...m(), sourceId: s.id, runId: preview.id });
    expect(final.status).toBe("complete");
    expect((await sources.get(owner, s.id)).bindings).toHaveLength(2);
    expect(
      (
        await pool.query("SELECT 1 FROM skill_version_git_provenance WHERE run_id=$1", [
          preview.id,
        ])
      ).rowCount,
    ).toBe(2);
    // Model a crash after version+provenance commit, before result/binding commit.
    const recovery = (await sources.get(owner, s.id)).source;
    await pool.query(
      "DELETE FROM skill_source_bindings WHERE source_id=$1 AND skill_path='one'",
      [s.id],
    );
    await pool.query(
      "UPDATE skill_source_runs SET status='partial',results='[]' WHERE id=$1",
      [preview.id],
    );
    await pool.query("UPDATE skill_sources SET revision=$2 WHERE id=$1", [
      s.id,
      recovery.revision - 1,
    ]);
    const resumed = await sources.apply({ ...m(), sourceId: s.id, runId: preview.id });
    expect(resumed.status).toBe("complete");
    expect(
      (
        await pool.query("SELECT 1 FROM skill_version_git_provenance WHERE run_id=$1", [
          preview.id,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("requires explicit manual bindings and preserves history across disconnect and rebind", async () => {
    const manualBundle = await bundle(
      "manual-review",
      "# Manual review\nInspect evidence.",
    );
    const manual = await skills.create({
      workspaceId: owner.workspaceId,
      principal: owner,
      archiveBytes: manualBundle.bytes,
      visibility: "workspace",
      idempotencyKey: crypto.randomUUID(),
      requestId: crypto.randomUUID(),
      fencingEpoch: 1,
    });
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/manual" },
      idempotencyKey: crypto.randomUUID(),
    });
    snapshot = {
      commitSha: "1".repeat(40),
      skills: [{ path: "old", bundle: manualBundle, error: null }],
    };
    expect(
      (await sources.preview({ ...m(), sourceId: source.id })).plan[0]?.action,
    ).toBe("conflict");
    await sources.bind({
      ...m(),
      sourceId: source.id,
      path: "old",
      skillId: manual.skill.id,
    });
    const preview = await sources.preview({ ...m(), sourceId: source.id });
    expect(preview.plan[0]?.action).toBe("unchanged");
    await sources.apply({ ...m(), sourceId: source.id, runId: preview.id });
    expect(
      (
        await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [
          manual.skill.id,
        ])
      ).rowCount,
    ).toBe(1);
    await sources.disconnect({ ...m(), sourceId: source.id, path: "old" });
    expect((await sources.get(owner, source.id)).bindings[0]?.status).toBe(
      "disconnected",
    );
    await sources.bind({
      ...m(),
      sourceId: source.id,
      path: "renamed",
      skillId: manual.skill.id,
    });
    snapshot = {
      commitSha: "2".repeat(40),
      skills: [{ path: "renamed", bundle: manualBundle, error: null }],
    };
    expect(
      (await sources.preview({ ...m(), sourceId: source.id })).plan.map(
        (p) => p.action,
      ),
    ).toEqual(["unchanged"]);
    expect(
      (await skills.get({ skillId: manual.skill.id, principal: owner }))
        .currentPublishedVersionId,
    ).toBe(manual.version.id);
    expect(
      (
        await skills.listPage({
          workspaceId: owner.workspaceId,
          principal: owner,
          sourceId: source.id,
        })
      ).skills.map((s) => s.id),
    ).toEqual([manual.skill.id]);
  });
  it("rejects stale previews, source mutation during sync and foreign bindings", async () => {
    const s = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/stale" },
      idempotencyKey: crypto.randomUUID(),
    });
    snapshot = { commitSha: "f".repeat(40), skills: [] };
    const preview = await sources.preview({ ...m(), sourceId: s.id });
    await sources.update({
      ...m(),
      sourceId: s.id,
      expectedRevision: s.revision,
      config: { repositoryUrl: s.repositoryUrl, ref: "other" },
      archived: false,
    });
    await expect(
      sources.apply({ ...m(), sourceId: s.id, runId: preview.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const foreign = await pool.query<{ id: string }>(
      "SELECT id FROM skills WHERE workspace_id=$1 LIMIT 1",
      [other.workspaceId],
    );
    await expect(
      sources.bind({
        ...m(),
        sourceId: s.id,
        path: "one",
        skillId: foreign.rows[0]?.id ?? "",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const current = (await sources.get(owner, s.id)).source;
    await pool.query(
      "UPDATE skill_sources SET sync_token='test',sync_expires_at=now()+interval '1 minute' WHERE id=$1",
      [s.id],
    );
    await expect(
      sources.update({
        ...m(),
        sourceId: s.id,
        expectedRevision: current.revision,
        config: { repositoryUrl: s.repositoryUrl },
        archived: true,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await pool.query(
      "UPDATE skill_sources SET sync_token=NULL,sync_expires_at=NULL WHERE id=$1",
      [s.id],
    );
    const retryPreview = await sources.preview({ ...m(), sourceId: s.id });
    failProvider = true;
    await expect(sources.preview({ ...m(), sourceId: s.id })).rejects.toThrow();
    await expect(
      sources.apply({ ...m(), sourceId: s.id, runId: retryPreview.id }),
    ).rejects.toThrow();
    expect((await sources.get(owner, s.id)).runs[0]).toMatchObject({
      status: "partial",
      failureMessage: "Source sync could not complete; retry this preview",
    });
    failProvider = false;
    expect(
      (await sources.apply({ ...m(), sourceId: s.id, runId: retryPreview.id })).status,
    ).toBe("complete");
    expect((await sources.get(owner, s.id)).bindings).toHaveLength(0);
  });
});
