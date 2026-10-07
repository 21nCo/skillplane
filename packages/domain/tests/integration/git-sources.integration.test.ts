import { assertGitSourceLease } from "../../src/git-provenance.js";
import { PublicationService } from "../../src/publication.js";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { migrateDatabase } from "../../../db/src/migrate.js";
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
        if (mode === "archive")
          await sources.update({
            ...m(),
            sourceId: source.id,
            expectedRevision: source.revision,
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
});
