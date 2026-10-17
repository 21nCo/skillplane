import { assertGitSourceLease } from "../../src/git-provenance.js";
import { PublicationService } from "../../src/publication.js";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { migrateDatabase } from "../../../db/src/migrate.js";
import { resolveTestDatabaseUrl } from "../../../db/src/database-url.js";
import { seedTenantFixture } from "../../../testing/src/fixtures.js";
import { createSkillBundleFixture } from "../../../testing/src/skill-bundles.js";
import { TestObjectStorage } from "../../../testing/src/runtime.js";
import {
  canonicalizeBundle,
  canonicalizeBundleFiles,
  R2BundleRepository,
} from "@skillplane/storage";
import { IdempotencyStore } from "../../src/idempotency.js";
import { SkillService } from "../../src/skills.js";
import { SkillVersionService } from "../../src/skill-versions.js";
import { SkillGroupService } from "../../src/skill-groups.js";
import { SkillSearchService } from "../../src/search.js";
import { GitSourceService } from "../../src/git-sources.js";
import type { GitSnapshot } from "../../src/git-source-provider.js";
import type { Principal } from "../../src/principal.js";
// This acceptance suite must fail, never skip, when no test database resolves.
describe("Git source persistence and recovery", () => {
  let url: string,
    pool: Pool,
    skills: SkillService,
    versions: SkillVersionService,
    sources: GitSourceService;
  const objects = new TestObjectStorage(),
    storage = new R2BundleRepository(objects);
  let snapshot: GitSnapshot = { commitSha: "a".repeat(40), skills: [] },
    failProvider = false;
  const provider = {
    snapshot: async (_config: unknown, commit?: string) => {
      if (failProvider) throw new Error("provider unavailable");
      expect(commit ?? snapshot.commitSha).toBe(snapshot.commitSha);
      return snapshot;
    },
  };
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
    url = await resolveTestDatabaseUrl();
    pool = new Pool({ connectionString: url, max: 4 });
    skills = new SkillService(pool, storage);
    versions = new SkillVersionService(pool, storage, new IdempotencyStore(pool));
    sources = new GitSourceService(pool, skills, versions, provider);
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
  afterAll(() => pool?.end());
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
    await expect(
      pool.query("DELETE FROM skill_version_git_provenance WHERE version_id=$1", [
        versionId,
      ]),
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
    const groupService = new SkillGroupService(pool),
      group = await groupService.create({
        ...m(),
        name: `Import review ${crypto.randomUUID()}`,
        idempotencyKey: crypto.randomUUID(),
      });
    for (const binding of (await sources.get(owner, s.id)).bindings)
      await groupService.association({
        ...m(),
        groupId: group.id,
        kind: "skill",
        targetId: binding.skillId,
        add: true,
      });
    const filter = {
      workspaceId: owner.workspaceId,
      principal: owner,
      groupId: group.id,
      sourceId: s.id,
      limit: 1,
    };
    const page = await skills.listPage(filter);
    expect(page.skills).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
    const next = await skills.listPage({ ...filter, cursor: page.nextCursor });
    expect(next.skills).toHaveLength(1);
    expect(next.skills[0]?.id).not.toBe(page.skills[0]?.id);
    await expect(
      skills.listPage({ ...filter, cursor: page.nextCursor, sourceId: "other-source" }),
    ).rejects.toMatchObject({ code: "CURSOR_FILTER_MISMATCH" });
    const search = new SkillSearchService(
        pool,
        "git-group-search-cursor-secret-32chars",
      ),
      found = await search.search({ ...filter, query: "Review" });
    expect(found.skills).toHaveLength(1);
    expect(found.nextCursor).toBeTruthy();
    expect(
      (await search.search({ ...filter, query: "Review", cursor: found.nextCursor }))
        .skills[0]?.id,
    ).not.toBe(found.skills[0]?.id);
    await expect(
      search.search({
        ...filter,
        query: "Review",
        cursor: found.nextCursor,
        sourceId: "other-source",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_FILTER_MISMATCH" });
    // Model a crash after version+provenance commit, before result/binding commit.
    // The source revision still equals this run's own last claim.
    await pool.query(
      "DELETE FROM skill_source_bindings WHERE source_id=$1 AND skill_path='one'",
      [s.id],
    );
    await pool.query(
      "UPDATE skill_source_runs SET status='partial',results='[]' WHERE id=$1",
      [preview.id],
    );
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
  it("fences stalled version writes and run mutations after source lease expiry or takeover", async () => {
    for (const mode of ["archive", "takeover"] as const) {
      const source = await sources.create({
        ...m(),
        config: { repositoryUrl: `https://github.com/a/lease-${mode}` },
        idempotencyKey: crypto.randomUUID(),
      });
      const slug = `lease-${mode}-${crypto.randomUUID()}`;
      snapshot = {
        commitSha: "a".repeat(40),
        skills: [
          { path: "one", bundle: await bundle(slug, "# Lease test"), error: null },
        ],
      };
      const preview = await sources.preview({ ...m(), sourceId: source.id });
      const original = storage.putCanonicalBundle.bind(storage);
      storage.putCanonicalBundle = async (...args) => {
        await pool.query(
          "UPDATE skill_sources SET sync_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [source.id],
        );
        // Apply bumped the revision on claim; archive at the current one.
        if (mode === "archive")
          await sources.update({
            ...m(),
            sourceId: source.id,
            expectedRevision: (await sources.get(owner, source.id)).source.revision,
            config: { repositoryUrl: source.repositoryUrl },
            archived: true,
          });
        else {
          await pool.query(
            "UPDATE skill_sources SET sync_token='replacement-token',sync_expires_at=clock_timestamp()+interval '3 minutes' WHERE id=$1",
            [source.id],
          );
          await pool.query(
            "UPDATE skill_source_runs SET status='partial',failure_message='new owner state' WHERE id=$1",
            [preview.id],
          );
        }
        return original(...args);
      };
      try {
        await expect(
          sources.apply({ ...m(), sourceId: source.id, runId: preview.id }),
        ).rejects.toMatchObject({ code: "GIT_SOURCE_LEASE_LOST" });
      } finally {
        storage.putCanonicalBundle = original;
      }
      expect(
        (
          await pool.query("SELECT 1 FROM skills WHERE workspace_id=$1 AND slug=$2", [
            owner.workspaceId,
            slug,
          ])
        ).rowCount,
      ).toBe(0);
      const detail = await sources.get(owner, source.id);
      expect(detail.bindings).toHaveLength(0);
      expect(detail.runs[0]?.results).toEqual([]);
      if (mode === "archive") expect(detail.source.archivedAt).not.toBeNull();
      if (mode === "takeover") {
        expect(detail.runs[0]?.failureMessage).toBe("new owner state");
        expect(
          (
            await pool.query("SELECT sync_token FROM skill_sources WHERE id=$1", [
              source.id,
            ])
          ).rows[0]?.sync_token,
        ).toBe("replacement-token");
      }
    }
  });
  it("recognizes identical format-v2 explicit bindings after server lock generation", async () => {
    const slug = `composite-${crypto.randomUUID()}`;
    const canonical = await canonicalizeBundleFiles({
      skill: {
        formatVersion: 2,
        name: slug,
        slug,
        description: "Review workflows",
        tags: [],
        entrypoints: { execute: "SKILL.md" },
        dependencies: [],
      },
      files: new Map([["SKILL.md", new TextEncoder().encode("# Composite")]]),
    });
    const manual = await skills.create({
      ...m(),
      workspaceId: owner.workspaceId,
      archiveBytes: canonical.bytes,
      visibility: "private",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(manual.version.digest).not.toBe(canonical.digest);
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/composite" },
      idempotencyKey: crypto.randomUUID(),
    });
    await sources.bind({
      ...m(),
      sourceId: source.id,
      path: "composite",
      skillId: manual.skill.id,
    });
    snapshot = {
      commitSha: "b".repeat(40),
      skills: [{ path: "composite", bundle: canonical, error: null }],
    };
    const preview = await sources.preview({ ...m(), sourceId: source.id });
    expect(preview.plan[0]?.action).toBe("unchanged");
    const applied = await sources.apply({
      ...m(),
      sourceId: source.id,
      runId: preview.id,
    });
    expect(applied.status).toBe("complete");
    expect(applied.results[0]?.status).toBe("unchanged");
    expect(
      (
        await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [
          manual.skill.id,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it("rejects unchanged previews and recovery when imported candidates are later rejected", async () => {
    const slug = `review-race-${crypto.randomUUID()}`;
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/review-race" },
      idempotencyKey: crypto.randomUUID(),
    });
    snapshot = {
      commitSha: "a".repeat(40),
      skills: [{ path: "review", bundle: await bundle(slug, "# A"), error: null }],
    };
    const a = await sources.preview({ ...m(), sourceId: source.id });
    await sources.apply({ ...m(), sourceId: source.id, runId: a.id });
    snapshot = {
      commitSha: "b".repeat(40),
      skills: [{ path: "review", bundle: await bundle(slug, "# B"), error: null }],
    };
    const b = await sources.preview({ ...m(), sourceId: source.id });
    const pending = await sources.apply({ ...m(), sourceId: source.id, runId: b.id });
    const unchanged = await sources.preview({ ...m(), sourceId: source.id });
    expect(unchanged.plan[0]?.action).toBe("unchanged");
    const item = pending.results[0];
    if (!item?.skillId || !item.versionId)
      throw new Error("Import did not create a reviewable version");
    await new PublicationService(pool, storage, new IdempotencyStore(pool)).reject({
      ...m(),
      skillId: item.skillId,
      candidateVersionId: item.versionId,
      reason: "Needs changes",
      idempotencyKey: crypto.randomUUID(),
    });
    const stale = await sources.apply({
      ...m(),
      sourceId: source.id,
      runId: unchanged.id,
    });
    expect(stale.status).toBe("partial");
    expect(stale.results[0]).toMatchObject({
      status: "error",
      message: expect.stringContaining("rejected"),
    });
    expect((await sources.get(owner, source.id)).bindings[0]?.status).toBe(
      "pending_review",
    );
    expect(
      (await sources.preview({ ...m(), sourceId: source.id })).plan[0]?.action,
    ).toBe("conflict");
    // Model recovery of the version commit before result/source completion.
    const run = (
      await pool.query("SELECT source_revision FROM skill_source_runs WHERE id=$1", [
        b.id,
      ])
    ).rows[0];
    await pool.query(
      "UPDATE skill_source_runs SET status='partial',results='[]' WHERE id=$1",
      [b.id],
    );
    await pool.query("UPDATE skill_sources SET revision=$2 WHERE id=$1", [
      source.id,
      run.source_revision,
    ]);
    const recovery = await sources.apply({ ...m(), sourceId: source.id, runId: b.id });
    expect(recovery.results[0]).toMatchObject({
      status: "error",
      message: expect.stringContaining("rejected"),
    });
    expect(
      (
        await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [
          item.skillId,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("checks expiry after waiting to acquire the source row lock", async () => {
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/lock-wait" },
      idempotencyKey: crypto.randomUUID(),
    });
    const blocker = await pool.connect(),
      worker = await pool.connect();
    try {
      await pool.query(
        "UPDATE skill_sources SET sync_token='lock-wait',sync_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [source.id],
      );
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM skill_sources WHERE id=$1 FOR UPDATE", [
        source.id,
      ]);
      await worker.query("BEGIN");
      const pending = assertGitSourceLease(worker, owner.workspaceId, {
        sourceId: source.id,
        token: "lock-wait",
        revision: source.revision,
      });
      const rejection = expect(pending).rejects.toMatchObject({
        code: "GIT_SOURCE_LEASE_LOST",
      });
      await blocker.query("SELECT pg_sleep(1.1)");
      await blocker.query("COMMIT");
      await rejection;
    } finally {
      await blocker.query("ROLLBACK");
      await worker.query("ROLLBACK");
      blocker.release();
      worker.release();
    }
  });
  it("imports a new composite whose dependency is added earlier in the same sync", async () => {
    const workspace = (
      await pool.query<{ slug: string }>("SELECT slug FROM workspaces WHERE id=$1", [
        owner.workspaceId,
      ])
    ).rows[0]?.slug;
    const childSlug = `child-${crypto.randomUUID()}`,
      parentSlug = `parent-${crypto.randomUUID()}`;
    const parent = await canonicalizeBundleFiles({
      skill: {
        formatVersion: 2,
        name: parentSlug,
        slug: parentSlug,
        description: "Review workflows",
        tags: [],
        entrypoints: { execute: "SKILL.md" },
        dependencies: [
          {
            alias: "child",
            workspace: workspace ?? "",
            skill: childSlug,
            version: "^1.0.0",
            scope: "execution",
            mode: "invoke",
            required: true,
          },
        ],
      },
      files: new Map([["SKILL.md", new TextEncoder().encode("# Parent")]]),
    });
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/same-sync" },
      idempotencyKey: crypto.randomUUID(),
    });
    snapshot = {
      commitSha: "e".repeat(40),
      skills: [
        { path: "a-child", bundle: await bundle(childSlug, "# Child"), error: null },
        { path: "b-parent", bundle: parent, error: null },
      ],
    };
    const preview = await sources.preview({ ...m(), sourceId: source.id });
    expect(preview.plan.map((p) => p.action)).toEqual(["added", "added"]);
    const applied = await sources.apply({
      ...m(),
      sourceId: source.id,
      runId: preview.id,
    });
    expect(applied.results.map((r) => r.status)).toEqual(["imported", "imported"]);
    expect(applied.status).toBe("complete");
  });
  it("marks every entry sharing a discovered slug as a conflict", async () => {
    const slug = `duplicate-${crypto.randomUUID()}`;
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/duplicates" },
      idempotencyKey: crypto.randomUUID(),
    });
    snapshot = {
      commitSha: "f".repeat(40),
      skills: [
        { path: "a", bundle: await bundle(slug, "# First"), error: null },
        { path: "b", bundle: await bundle(slug, "# Second"), error: null },
      ],
    };
    const preview = await sources.preview({ ...m(), sourceId: source.id });
    expect(preview.plan.map((p) => p.action)).toEqual(["conflict", "conflict"]);
    const applied = await sources.apply({
      ...m(),
      sourceId: source.id,
      runId: preview.id,
    });
    expect(applied.results.every((r) => r.skillId === null)).toBe(true);
    expect(
      (
        await pool.query("SELECT 1 FROM skills WHERE workspace_id=$1 AND slug=$2", [
          owner.workspaceId,
          slug,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it("binds and disconnects SKILL.md file paths as their skill directory", async () => {
    const manualBundle = await bundle(
      `file-path-${crypto.randomUUID()}`,
      "# File path\nInspect evidence.",
    );
    const manual = await skills.create({
      ...m(),
      workspaceId: owner.workspaceId,
      archiveBytes: manualBundle.bytes,
      visibility: "private",
      idempotencyKey: crypto.randomUUID(),
    });
    const wide = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/file-paths" },
      idempotencyKey: crypto.randomUUID(),
    });
    await sources.bind({
      ...m(),
      sourceId: wide.id,
      path: "skills/review/SKILL.md",
      skillId: manual.skill.id,
    });
    expect((await sources.get(owner, wide.id)).bindings[0]?.path).toBe("skills/review");
    snapshot = {
      commitSha: "d".repeat(40),
      skills: [{ path: "skills/review", bundle: manualBundle, error: null }],
    };
    expect(
      (await sources.preview({ ...m(), sourceId: wide.id })).plan.map((p) => p.action),
    ).toEqual(["unchanged"]);
    expect(
      await sources.disconnect({
        ...m(),
        sourceId: wide.id,
        path: "skills/review/SKILL.md",
      }),
    ).toEqual({ changed: true });
    const single = await sources.create({
      ...m(),
      config: {
        repositoryUrl: "https://github.com/a/file-paths",
        path: "skills/review",
      },
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      sources.bind({
        ...m(),
        sourceId: single.id,
        path: "skills/review/SKILL.md",
        skillId: manual.skill.id,
      }),
    ).resolves.toEqual({ changed: true });
  });
  it("invalidates sibling previews on apply and never retargets an active binding", async () => {
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/siblings" },
      idempotencyKey: crypto.randomUUID(),
    });
    const first = `sibling-first-${crypto.randomUUID()}`,
      original = `sibling-original-${crypto.randomUUID()}`,
      renamed = `sibling-renamed-${crypto.randomUUID()}`;
    const before: GitSnapshot = {
      commitSha: "1".repeat(40),
      skills: [
        { path: "one", bundle: await bundle(first, "# One"), error: null },
        { path: "two", bundle: await bundle(original, "# Two"), error: null },
      ],
    };
    // The tracked ref moves between two previews taken at one source revision.
    const after: GitSnapshot = {
      commitSha: "2".repeat(40),
      skills: [{ path: "two", bundle: await bundle(renamed, "# Two"), error: null }],
    };
    snapshot = before;
    const a = await sources.preview({ ...m(), sourceId: source.id });
    snapshot = after;
    const b = await sources.preview({ ...m(), sourceId: source.id });
    expect(b.plan.map((p) => p.action)).toEqual(["added"]);
    snapshot = before;
    objects.failNextPut = true;
    const partial = await sources.apply({ ...m(), sourceId: source.id, runId: a.id });
    expect(partial.results.map((r) => r.status)).toEqual(["error", "imported"]);
    const boundSkill = partial.results[1]?.skillId;
    snapshot = after;
    await expect(
      sources.apply({ ...m(), sourceId: source.id, runId: b.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    // Even a sibling plan that is forced to apply cannot move the active binding.
    await pool.query(
      "UPDATE skill_sources SET revision=(SELECT source_revision FROM skill_source_runs WHERE id=$2) WHERE id=$1",
      [source.id, b.id],
    );
    const forced = await sources.apply({ ...m(), sourceId: source.id, runId: b.id });
    expect(forced.results[0]).toMatchObject({
      status: "error",
      message: expect.stringContaining("already bound"),
    });
    expect(
      (
        await pool.query("SELECT 1 FROM skills WHERE workspace_id=$1 AND slug=$2", [
          owner.workspaceId,
          renamed,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await sources.get(owner, source.id)).bindings).toEqual([
      expect.objectContaining({
        path: "two",
        skillId: boundSkill,
        disconnectedAt: null,
      }),
    ]);
  });
  it("keeps a disconnected mapping when its path is bound to another skill", async () => {
    const created = [];
    for (const name of ["first", "second"]) {
      const b = await bundle(`rebind-${name}-${crypto.randomUUID()}`, `# ${name}`);
      created.push(
        await skills.create({
          ...m(),
          workspaceId: owner.workspaceId,
          archiveBytes: b.bytes,
          visibility: "private",
          idempotencyKey: crypto.randomUUID(),
        }),
      );
    }
    const [first, second] = created.map((c) => c.skill.id);
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/rebind" },
      idempotencyKey: crypto.randomUUID(),
    });
    await sources.bind({
      ...m(),
      sourceId: source.id,
      path: "p",
      skillId: first ?? "",
    });
    await expect(
      sources.bind({ ...m(), sourceId: source.id, path: "p", skillId: second ?? "" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await sources.disconnect({ ...m(), sourceId: source.id, path: "p" });
    await sources.bind({
      ...m(),
      sourceId: source.id,
      path: "p",
      skillId: second ?? "",
    });
    const { bindings } = await sources.get(owner, source.id);
    expect(bindings.map((b) => [b.path, b.skillId, b.disconnectedAt === null])).toEqual(
      [
        ["p", second, true],
        ["p", first, false],
      ],
    );
    expect(new Set(bindings.map((b) => b.id)).size).toBe(2);
  });
  it("caps active bindings in preview and apply, counting missing paths", async () => {
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/binding-cap" },
      idempotencyKey: crypto.randomUUID(),
    });
    const prefix = `cap-${crypto.randomUUID()}`;
    snapshot = {
      commitSha: "3".repeat(40),
      skills: await Promise.all(
        Array.from({ length: 33 }, async (_, i) => ({
          path: `p${String(i).padStart(2, "0")}`,
          bundle: await bundle(`${prefix}-${String(i)}`, `# Skill ${String(i)}`),
          error: null,
        })),
      ),
    };
    const preview = await sources.preview({ ...m(), sourceId: source.id });
    expect(preview.plan.filter((p) => p.action === "added")).toHaveLength(32);
    expect(preview.plan[32]).toMatchObject({
      path: "p32",
      action: "conflict",
      message: expect.stringContaining("at most 32"),
    });
    const applied = await sources.apply({
      ...m(),
      sourceId: source.id,
      runId: preview.id,
    });
    expect(applied.status).toBe("complete");
    expect(applied.results[32]).toMatchObject({ status: "conflict", skillId: null });
    const count = async () =>
      (
        await pool.query(
          "SELECT 1 FROM skills WHERE workspace_id=$1 AND slug LIKE $2",
          [owner.workspaceId, `${prefix}-%`],
        )
      ).rowCount;
    expect(await count()).toBe(32);
    snapshot = {
      commitSha: "4".repeat(40),
      skills: [
        { path: "new", bundle: await bundle(`${prefix}-new`, "# New"), error: null },
      ],
    };
    const next = await sources.preview({ ...m(), sourceId: source.id });
    expect(next.plan).toHaveLength(33);
    expect(next.plan.find((p) => p.path === "new")?.action).toBe("conflict");
    expect(next.plan.filter((p) => p.action === "missing")).toHaveLength(32);
    await sources.apply({ ...m(), sourceId: source.id, runId: next.id });
    expect(await count()).toBe(32);
  }, 60000);
  it("converges to the published head when upstream reverts a rejected candidate", async () => {
    const slug = `revert-${crypto.randomUUID()}`;
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/revert" },
      idempotencyKey: crypto.randomUUID(),
    });
    const sync = async (commit: string, content: string) => {
      snapshot = {
        commitSha: commit.repeat(40),
        skills: [{ path: "review", bundle: await bundle(slug, content), error: null }],
      };
      const preview = await sources.preview({ ...m(), sourceId: source.id });
      return {
        preview,
        applied: await sources.apply({
          ...m(),
          sourceId: source.id,
          runId: preview.id,
        }),
      };
    };
    const published = (await sync("5", "# One")).applied.results[0];
    const candidate = (await sync("6", "# Two")).applied.results[0];
    expect(candidate?.status).toBe("pending_review");
    await new PublicationService(pool, storage, new IdempotencyStore(pool)).reject({
      ...m(),
      skillId: candidate?.skillId ?? "",
      candidateVersionId: candidate?.versionId ?? "",
      reason: "Needs changes",
      idempotencyKey: crypto.randomUUID(),
    });
    for (const commit of ["7", "8"]) {
      const { preview, applied } = await sync(commit, "# One");
      expect(preview.plan[0]?.action).toBe("unchanged");
      expect(applied.status).toBe("complete");
      expect(applied.results[0]?.status).toBe("unchanged");
    }
    expect((await sources.get(owner, source.id)).bindings[0]).toMatchObject({
      lastVersionId: published?.versionId,
      lastCommitSha: "8".repeat(40),
      status: "unchanged",
    });
    expect(
      (
        await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [
          published?.skillId,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("reports invalid skills, rejects stale previews after a completed sync and restores archived sources", async () => {
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/lifecycle" },
      idempotencyKey: crypto.randomUUID(),
    });
    snapshot = {
      commitSha: "9".repeat(40),
      skills: [
        { path: "bad", bundle: null, error: "Skill metadata is invalid" },
        {
          path: "good",
          bundle: await bundle(`lifecycle-${crypto.randomUUID()}`, "# Good"),
          error: null,
        },
      ],
    };
    const older = await sources.preview({ ...m(), sourceId: source.id });
    const newer = await sources.preview({ ...m(), sourceId: source.id });
    expect(older.plan.map((p) => p.action)).toEqual(["invalid", "added"]);
    const applied = await sources.apply({
      ...m(),
      sourceId: source.id,
      runId: newer.id,
    });
    expect(applied.status).toBe("complete");
    expect(applied.results.map((r) => r.status)).toEqual(["invalid", "imported"]);
    await expect(
      sources.apply({ ...m(), sourceId: source.id, runId: older.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const versionId = applied.results[1]?.versionId ?? "";
    let current = (await sources.get(owner, source.id)).source;
    const archived = await sources.update({
      ...m(),
      sourceId: source.id,
      expectedRevision: current.revision,
      config: { repositoryUrl: current.repositoryUrl },
      archived: true,
    });
    await expect(
      sources.preview({ ...m(), sourceId: source.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await sources.get(owner, source.id)).bindings).toHaveLength(1);
    expect(await sources.provenance(owner, versionId)).not.toBeNull();
    current = await sources.update({
      ...m(),
      sourceId: source.id,
      expectedRevision: archived.revision,
      config: { repositoryUrl: current.repositoryUrl },
      archived: false,
    });
    expect(current.archivedAt).toBeNull();
    expect(
      (await sources.preview({ ...m(), sourceId: source.id })).plan.map(
        (p) => p.action,
      ),
    ).toEqual(["invalid", "unchanged"]);
  });
  it("commits an unchanged binding transition with its result so an interrupted retry converges", async () => {
    const slug = `interrupted-${crypto.randomUUID()}`,
      content = await bundle(slug, "# Interrupted\nReview.");
    const manual = await skills.create({
      ...m(),
      workspaceId: owner.workspaceId,
      archiveBytes: content.bytes,
      visibility: "private",
      idempotencyKey: crypto.randomUUID(),
    });
    // A dedicated pool whose clients fail the first per-item result write.
    const injected = new Pool({ connectionString: url, max: 2 });
    let failures = 1;
    injected.on("connect", (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as { query: unknown }).query = (...args: unknown[]) => {
        if (
          failures > 0 &&
          typeof args[0] === "string" &&
          args[0].startsWith("UPDATE skill_source_runs SET results=$4,status='partial'")
        ) {
          failures--;
          return Promise.reject(new Error("result write interrupted"));
        }
        return query(...args);
      };
    });
    const interrupted = new GitSourceService(injected, skills, versions, provider);
    try {
      const source = await interrupted.create({
        ...m(),
        config: { repositoryUrl: "https://github.com/a/interrupted" },
        idempotencyKey: crypto.randomUUID(),
      });
      await interrupted.bind({
        ...m(),
        sourceId: source.id,
        path: "review",
        skillId: manual.skill.id,
      });
      snapshot = {
        commitSha: "d".repeat(40),
        skills: [{ path: "review", bundle: content, error: null }],
      };
      const preview = await interrupted.preview({ ...m(), sourceId: source.id });
      expect(preview.plan[0]).toMatchObject({
        action: "unchanged",
        bindingVersionId: null,
      });
      await interrupted
        .apply({ ...m(), sourceId: source.id, runId: preview.id })
        .catch(() => undefined);
      expect(failures).toBe(0);
      const retried = await interrupted.apply({
        ...m(),
        sourceId: source.id,
        runId: preview.id,
      });
      expect(retried.status).toBe("complete");
      expect(retried.results[0]).toMatchObject({ status: "unchanged", message: null });
      expect((await interrupted.get(owner, source.id)).bindings[0]).toMatchObject({
        status: "unchanged",
        lastVersionId: manual.version.id,
        lastCommitSha: "d".repeat(40),
      });
      expect(
        (
          await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [
            manual.skill.id,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      await injected.end();
    }
  });
  it("keeps a committed item result when its COMMIT acknowledgement is lost", async () => {
    // A dedicated pool whose clients commit the first per-item result write on
    // the server, then report a failure to the caller once.
    const lost = new Pool({ connectionString: url, max: 2 });
    let failures = 0;
    lost.on("connect", (client) => {
      const query = client.query.bind(client) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      let wroteResult = false;
      (client as { query: unknown }).query = async (...args: unknown[]) => {
        const text = typeof args[0] === "string" ? args[0] : "";
        if (text === "BEGIN") wroteResult = false;
        if (text.startsWith("UPDATE skill_source_runs SET results=$4,status='partial'"))
          wroteResult = true;
        const output = await query(...args);
        if (text === "COMMIT" && wroteResult && failures > 0) {
          failures--;
          throw new Error("commit acknowledgement lost");
        }
        return output;
      };
    });
    const ambiguous = new GitSourceService(lost, skills, versions, provider);
    const count = async (skillId: string) =>
      (await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [skillId]))
        .rowCount;
    const applyLosingCommit = async (sourceId: string) => {
      const preview = await ambiguous.preview({ ...m(), sourceId });
      failures = 1;
      const applied = await ambiguous.apply({ ...m(), sourceId, runId: preview.id });
      expect(failures).toBe(0);
      const stored = await pool.query<{ status: string; results: unknown[] }>(
        "SELECT status,results FROM skill_source_runs WHERE id=$1",
        [preview.id],
      );
      expect(stored.rows[0]?.status).toBe("complete");
      expect(stored.rows[0]?.results).toEqual(applied.results);
      const replayed = await ambiguous.apply({ ...m(), sourceId, runId: preview.id });
      expect(replayed.results).toEqual(applied.results);
      return { preview, applied };
    };
    try {
      // An explicit bind whose published bundle equals upstream.
      const slug = `lost-bind-${crypto.randomUUID()}`,
        content = await bundle(slug, "# Lost bind\nReview.");
      const manual = await skills.create({
        ...m(),
        workspaceId: owner.workspaceId,
        archiveBytes: content.bytes,
        visibility: "private",
        idempotencyKey: crypto.randomUUID(),
      });
      const bound = await ambiguous.create({
        ...m(),
        config: { repositoryUrl: "https://github.com/a/lost-bind" },
        idempotencyKey: crypto.randomUUID(),
      });
      await ambiguous.bind({
        ...m(),
        sourceId: bound.id,
        path: "review",
        skillId: manual.skill.id,
      });
      snapshot = {
        commitSha: "e".repeat(40),
        skills: [{ path: "review", bundle: content, error: null }],
      };
      const explicit = await applyLosingCommit(bound.id);
      expect(explicit.preview.plan[0]).toMatchObject({
        action: "unchanged",
        bindingVersionId: null,
      });
      expect(explicit.applied.status).toBe("complete");
      expect(explicit.applied.results[0]).toMatchObject({
        status: "unchanged",
        message: null,
      });
      expect((await ambiguous.get(owner, bound.id)).bindings[0]).toMatchObject({
        status: "unchanged",
        lastVersionId: manual.version.id,
        lastCommitSha: "e".repeat(40),
      });
      expect(await count(manual.skill.id)).toBe(1);

      // Returning to the content of an earlier, still-pending candidate.
      const reuseSlug = `lost-reuse-${crypto.randomUUID()}`;
      const reuse = await sources.create({
        ...m(),
        config: { repositoryUrl: "https://github.com/a/lost-reuse" },
        idempotencyKey: crypto.randomUUID(),
      });
      const sync = async (commit: string, body: string) => {
        snapshot = {
          commitSha: commit.repeat(40),
          skills: [
            { path: "review", bundle: await bundle(reuseSlug, body), error: null },
          ],
        };
        const preview = await sources.preview({ ...m(), sourceId: reuse.id });
        return (await sources.apply({ ...m(), sourceId: reuse.id, runId: preview.id }))
          .results[0];
      };
      const published = await sync("1", "# One");
      const first = await sync("2", "# Two");
      expect((await sync("3", "# Three"))?.status).toBe("pending_review");
      snapshot = {
        commitSha: "4".repeat(40),
        skills: [
          { path: "review", bundle: await bundle(reuseSlug, "# Two"), error: null },
        ],
      };
      const candidate = await applyLosingCommit(reuse.id);
      expect(candidate.preview.plan[0]).toMatchObject({
        action: "unchanged",
        candidateVersionId: first?.versionId,
      });
      expect(candidate.applied.status).toBe("complete");
      expect(candidate.applied.results[0]).toMatchObject({
        status: "unchanged",
        versionId: first?.versionId,
        message: "The imported candidate is awaiting review",
      });
      expect((await sources.get(owner, reuse.id)).bindings[0]).toMatchObject({
        status: "pending_review",
        lastVersionId: first?.versionId,
        lastCommitSha: "4".repeat(40),
      });
      expect(await count(published?.skillId ?? "")).toBe(3);
    } finally {
      await lost.end();
    }
  });
  it("keeps a pending imported candidate in review when identical content syncs again", async () => {
    const slug = `pending-${crypto.randomUUID()}`;
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/pending" },
      idempotencyKey: crypto.randomUUID(),
    });
    const sync = async (commit: string, content: string) => {
      snapshot = {
        commitSha: commit.repeat(40),
        skills: [{ path: "review", bundle: await bundle(slug, content), error: null }],
      };
      const preview = await sources.preview({ ...m(), sourceId: source.id });
      return {
        preview,
        applied: await sources.apply({
          ...m(),
          sourceId: source.id,
          runId: preview.id,
        }),
      };
    };
    await sync("1", "# One");
    const candidate = (await sync("2", "# Two")).applied.results[0];
    expect(candidate?.status).toBe("pending_review");
    const { preview, applied } = await sync("3", "# Two");
    expect(preview.plan[0]).toMatchObject({
      action: "unchanged",
      message: "The imported candidate is awaiting review",
    });
    expect(applied.status).toBe("complete");
    expect(applied.results[0]).toMatchObject({
      status: "unchanged",
      versionId: candidate?.versionId,
    });
    expect((await sources.get(owner, source.id)).bindings[0]).toMatchObject({
      status: "pending_review",
      lastVersionId: candidate?.versionId,
      lastCommitSha: "3".repeat(40),
    });
    expect(
      (
        await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [
          candidate?.skillId,
        ])
      ).rowCount,
    ).toBe(2);
  });
  it("tracks a pending imported candidate across an upstream revert and reuses identical candidates", async () => {
    const slug = `reuse-${crypto.randomUUID()}`;
    const source = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/a/reuse" },
      idempotencyKey: crypto.randomUUID(),
    });
    const sync = async (commit: string, content: string) => {
      snapshot = {
        commitSha: commit.repeat(40),
        skills: [{ path: "review", bundle: await bundle(slug, content), error: null }],
      };
      const preview = await sources.preview({ ...m(), sourceId: source.id });
      return {
        preview,
        applied: await sources.apply({
          ...m(),
          sourceId: source.id,
          runId: preview.id,
        }),
      };
    };
    const binding = async () => (await sources.get(owner, source.id)).bindings[0];
    const count = async (skillId: string | null | undefined) =>
      (await pool.query("SELECT 1 FROM skill_versions WHERE skill_id=$1", [skillId]))
        .rowCount;
    const published = (await sync("1", "# One")).applied.results[0];
    const first = (await sync("2", "# Two")).applied.results[0];
    expect(first?.status).toBe("pending_review");
    // Upstream reverts to the published content: the candidate stays tracked.
    const reverted = await sync("3", "# One");
    expect(reverted.preview.plan[0]).toMatchObject({
      action: "unchanged",
      message:
        "Upstream matches the published version; the imported candidate is still awaiting review",
    });
    expect(reverted.applied.results[0]).toMatchObject({
      status: "unchanged",
      versionId: first?.versionId,
      message: reverted.preview.plan[0]?.message,
    });
    expect(await binding()).toMatchObject({
      status: "pending_review",
      lastVersionId: first?.versionId,
    });
    const again = await sync("4", "# Two");
    expect(again.preview.plan[0]).toMatchObject({
      action: "unchanged",
      message: "The imported candidate is awaiting review",
    });
    expect(again.applied.results[0]).toMatchObject({
      status: "unchanged",
      versionId: first?.versionId,
    });
    expect(await binding()).toMatchObject({
      status: "pending_review",
      lastVersionId: first?.versionId,
    });
    expect(await count(published?.skillId)).toBe(2);
    // A newer candidate replaces the tracked one; returning to the earlier
    // content binds its still-pending candidate instead of importing it again.
    const second = (await sync("5", "# Three")).applied.results[0];
    expect(second?.status).toBe("pending_review");
    expect(second?.versionId).not.toBe(first?.versionId);
    const back = await sync("6", "# Two");
    expect(back.preview.plan[0]).toMatchObject({
      action: "unchanged",
      candidateVersionId: first?.versionId,
      message: "The imported candidate is awaiting review",
    });
    expect(back.applied.status).toBe("complete");
    expect(back.applied.results[0]).toMatchObject({
      status: "unchanged",
      versionId: first?.versionId,
    });
    expect(await binding()).toMatchObject({
      status: "pending_review",
      lastVersionId: first?.versionId,
      lastCommitSha: "6".repeat(40),
    });
    expect(await count(published?.skillId)).toBe(3);
    // Identical content then remains unchanged without another version.
    expect((await sync("7", "# Two")).applied.results[0]).toMatchObject({
      status: "unchanged",
      versionId: first?.versionId,
    });
    expect(await count(published?.skillId)).toBe(3);
  });
});
