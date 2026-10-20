import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrateDatabase } from "../../../db/src/migrate.js";
import { resolveTestDatabaseUrl } from "../../../db/src/database-url.js";
import { seedTenantFixture } from "../../../testing/src/fixtures.js";
import { directoryGitHubFetcher } from "../../../testing/src/git-directory.js";
import {
  createInstructionsBundleFixture,
  createSkillBundleFixture,
} from "../../../testing/src/skill-bundles.js";
import { TestObjectStorage } from "../../../testing/src/runtime.js";
import {
  canonicalizeBundle,
  canonicalizeBundleFiles,
  R2BundleRepository,
  serializeWorkspaceRepository,
  WORKSPACE_MANIFEST_PATH,
  type WorkspaceManifest,
  type WorkspaceRepositorySkill,
  type WorkspaceRepositoryVisibility,
  WorkspaceRepositoryError,
} from "@skillplane/storage";
import { IdempotencyStore } from "../../src/idempotency.js";
import { PublicationService } from "../../src/publication.js";
import { SkillService } from "../../src/skills.js";
import { SkillVersionService } from "../../src/skill-versions.js";
import { GitSourceService } from "../../src/git-sources.js";
import { PublicGitHubSourceProvider } from "../../src/git-source-provider.js";
import type { Principal } from "../../src/principal.js";

// The SKI-28 layout contract: the SKI-12 importer reads an exported workspace
// tree back as a no-op. This acceptance suite must fail, never skip, when no
// test database resolves.
describe("workspace repository export round trip", () => {
  let pool: Pool,
    skills: SkillService,
    versions: SkillVersionService,
    publication: PublicationService,
    sources: GitSourceService,
    owner: Principal;
  const storage = new R2BundleRepository(new TestObjectStorage()),
    directory = mkdtempSync(join(tmpdir(), "skillplane-workspace-repository-")),
    m = () => ({ principal: owner, requestId: crypto.randomUUID(), fencingEpoch: 1 });
  // Each preview reads the exported directory through the production
  // public GitHub provider, so SKI-12 discovery and validation apply.
  const provider = {
    snapshot: (config: Parameters<PublicGitHubSourceProvider["snapshot"]>[0]) =>
      new PublicGitHubSourceProvider(directoryGitHubFetcher(directory)).snapshot(
        config,
      ),
  };
  const archive = async (slug: string, markdown: string, files = {}) =>
    (
      await canonicalizeBundle(
        await createSkillBundleFixture({
          name: slug,
          slug,
          description: "Exported workflow",
          tags: ["export", slug],
          skillMarkdown: markdown,
          files,
        }),
      )
    ).bytes;
  const create = async (
    slug: string,
    visibility: WorkspaceRepositoryVisibility,
    bytes: Uint8Array,
  ) =>
    skills.create({
      ...m(),
      workspaceId: owner.workspaceId,
      archiveBytes: bytes,
      visibility,
      idempotencyKey: `create-${slug}`,
    });

  beforeAll(async () => {
    const url = await resolveTestDatabaseUrl();
    pool = new Pool({ connectionString: url, max: 4 });
    const idempotency = new IdempotencyStore(pool);
    skills = new SkillService(pool, storage);
    versions = new SkillVersionService(pool, storage, idempotency);
    publication = new PublicationService(pool, storage, idempotency);
    sources = new GitSourceService(pool, skills, versions, provider);
    await migrateDatabase(url);
    const tenant = await seedTenantFixture(url, `export-${crypto.randomUUID()}`);
    owner = {
      kind: "user",
      role: "owner",
      actorId: tenant.userId,
      userId: tenant.userId,
      sessionId: "s",
      workspaceId: tenant.workspaceId,
    };
    // The tenant fixture's search skill has no stored bundle to export.
    await pool.query("UPDATE skills SET archived_at=now() WHERE workspace_id=$1", [
      tenant.workspaceId,
    ]);
  }, 60000);
  afterAll(async () => {
    rmSync(directory, { recursive: true, force: true });
    await pool?.end();
  });

  it("exports current published skills that preview as unchanged when bound and as conflicts when unbound", async () => {
    // A republished private skill, with a newer pending candidate that must
    // not be exported.
    const review = await create(
      "review",
      "private",
      await archive("review", "# Review\n", {
        "references/checklist.md": "- Tests\r\n- Security\r\n",
      }),
    );
    const republished = await versions.createCandidate({
      ...m(),
      skillId: review.skill.id,
      baseVersionId: review.version.id,
      proposedBump: "minor",
      changeSummary: "Second edition",
      archiveBytes: await archive("review", "# Review\n\nSecond edition.\n", {
        "references/checklist.md": "- Tests\r\n- Security\r\n",
      }),
      idempotencyKey: "candidate-review",
    });
    await publication.publish({
      ...m(),
      skillId: review.skill.id,
      candidateVersionId: republished.id,
      idempotencyKey: "publish-review",
    });
    await versions.createCandidate({
      ...m(),
      skillId: review.skill.id,
      baseVersionId: republished.id,
      proposedBump: "patch",
      changeSummary: "Draft edition",
      archiveBytes: await archive("review", "# Review\n\nPENDING DRAFT.\n"),
      idempotencyKey: "candidate-draft",
    });
    const shared = await create(
      "deploy",
      "workspace",
      await archive("deploy", "# Deploy\n", { "scripts/ship.sh": "#!/bin/sh\n" }),
    );
    const open = await create(
      "triage",
      "public",
      await archive("triage", "# Triage\n"),
    );
    // A format-v2 composed skill carries a server-generated lock file.
    const workspaceSlug = (
      await pool.query<{ slug: string }>("SELECT slug FROM workspaces WHERE id=$1", [
        owner.workspaceId,
      ])
    ).rows[0]?.slug;
    const composed = await create(
      "release",
      "private",
      (
        await canonicalizeBundleFiles({
          skill: {
            formatVersion: 2,
            name: "release",
            slug: "release",
            description: "Composed workflow",
            tags: [],
            entrypoints: { execute: "SKILL.md" },
            dependencies: [
              {
                alias: "deploy",
                workspace: workspaceSlug ?? "",
                skill: "deploy",
                version: "^1.0.0",
                scope: "execution",
                mode: "invoke",
                required: true,
              },
            ],
          },
          files: new Map([["SKILL.md", new TextEncoder().encode("# Release\n")]]),
        })
      ).bytes,
    );
    const archived = await create(
      "legacy",
      "private",
      await archive("legacy", "# Old\n"),
    );
    await skills.setArchived({
      ...m(),
      skillId: archived.skill.id,
      archived: true,
      idempotencyKey: "archive-legacy",
    });
    await create(
      "agents",
      "private",
      await createInstructionsBundleFixture({
        name: "Agents",
        slug: "agents",
        document: "# Agents\n",
      }),
    );

    // Workspace state -> serializer input, by the documented selection rule.
    const rows = await pool.query<{
      id: string;
      visibility: WorkspaceRepositoryVisibility;
      semantic_version: string;
      content_digest: `sha256:${string}`;
      version_id: string;
    }>(
      `SELECT s.id, s.visibility, v.semantic_version, v.content_digest, v.id AS version_id
         FROM skills s
         JOIN skill_versions v ON v.workspace_id=s.workspace_id AND v.id=s.current_published_version_id
        WHERE s.workspace_id=$1 AND s.kind='skill' AND s.archived_at IS NULL AND v.status='published'`,
      [owner.workspaceId],
    );
    const input: WorkspaceRepositorySkill[] = [];
    for (const row of rows.rows)
      input.push({
        id: row.id,
        visibility: row.visibility,
        semanticVersion: row.semantic_version,
        digest: row.content_digest,
        bundle: await canonicalizeBundle(
          (
            await versions.retrieveBundle({
              skillId: row.id,
              versionId: row.version_id,
              principal: owner,
            })
          ).bytes,
        ),
      });
    const tree = await serializeWorkspaceRepository(input);
    for (const [path, bytes] of tree) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), bytes);
    }
    const manifest = JSON.parse(
      new TextDecoder().decode(tree.get(WORKSPACE_MANIFEST_PATH)),
    ) as WorkspaceManifest;
    expect(
      manifest.skills.map(({ id, slug, visibility, semanticVersion }) => ({
        id,
        slug,
        visibility,
        semanticVersion,
      })),
    ).toEqual([
      {
        id: shared.skill.id,
        slug: "deploy",
        visibility: "workspace",
        semanticVersion: "1.0.0",
      },
      {
        id: composed.skill.id,
        slug: "release",
        visibility: "private",
        semanticVersion: "1.0.0",
      },
      {
        id: review.skill.id,
        slug: "review",
        visibility: "private",
        semanticVersion: "1.1.0",
      },
      {
        id: open.skill.id,
        slug: "triage",
        visibility: "public",
        semanticVersion: "1.0.0",
      },
    ]);
    expect(manifest.skills.find((s) => s.slug === "review")?.digest).toBe(
      republished.digest,
    );
    expect(tree.has("skills/release/skill.lock.json")).toBe(true);
    expect(
      [...tree.values()].some((bytes) =>
        new TextDecoder().decode(bytes).includes("PENDING DRAFT"),
      ),
    ).toBe(false);
    const versionCount = async () =>
      Number(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM skill_versions WHERE workspace_id=$1",
            [owner.workspaceId],
          )
        ).rows[0]?.count,
      );
    const before = await versionCount();

    // Unbound: every exported skill is a conflict with its matching manual
    // slug and is never silently attached.
    const unbound = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/acme/unbound" },
      idempotencyKey: "source-unbound",
    });
    const conflicts = await sources.preview({ ...m(), sourceId: unbound.id });
    expect(
      conflicts.plan.map(({ path, slug, action, skillId }) => ({
        path,
        slug,
        action,
        skillId,
      })),
    ).toEqual(
      manifest.skills.map(({ path, slug }) => ({
        path,
        slug,
        action: "conflict",
        skillId: null,
      })),
    );
    for (const entry of conflicts.plan)
      expect(entry.digest).toBe(
        manifest.skills.find((s) => s.path === entry.path)?.digest,
      );

    // Bound to their exported paths: every entry is unchanged and applying the
    // plan creates no version.
    const bound = await sources.create({
      ...m(),
      config: { repositoryUrl: "https://github.com/acme/bound" },
      idempotencyKey: "source-bound",
    });
    for (const skill of manifest.skills)
      await sources.bind({
        ...m(),
        sourceId: bound.id,
        path: skill.path,
        skillId: skill.id,
      });
    const noop = await sources.preview({ ...m(), sourceId: bound.id });
    expect(
      noop.plan.map(({ path, action, skillId, message }) => ({
        path,
        action,
        skillId,
        message,
      })),
    ).toEqual(
      manifest.skills.map(({ path, id }) => ({
        path,
        action: "unchanged",
        skillId: id,
        message: null,
      })),
    );
    // The review skill's pending draft does not make its published head differ.
    const applied = await sources.apply({ ...m(), sourceId: bound.id, runId: noop.id });
    expect(applied.status).toBe("complete");
    expect(await versionCount()).toBe(before);
  });

  it("refuses to export published skills that the importer would read back as invalid", async () => {
    // Built at run time so the fixture is not itself a credential-shaped literal.
    const accessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    for (const [slug, files, rule] of [
      ["scaffold", { "templates/SKILL.md": "# Template\n" }, "nested skill root"],
      ["keyed", { "references/env.md": `key=${accessKey}\n` }, "credential"],
    ] as const) {
      const created = await create(
        slug,
        "workspace",
        await archive(slug, "# Skill\n", files),
      );
      const bundle = await canonicalizeBundle(
        (
          await versions.retrieveBundle({
            skillId: created.skill.id,
            versionId: created.version.id,
            principal: owner,
          })
        ).bytes,
      );
      // Written anyway, the directory previews as invalid rather than unchanged.
      const raw = mkdtempSync(join(tmpdir(), "skillplane-workspace-invalid-"));
      try {
        for (const [path, bytes] of bundle.files) {
          mkdirSync(dirname(join(raw, "skills", slug, path)), { recursive: true });
          writeFileSync(join(raw, "skills", slug, path), bytes);
        }
        const rawSources = new GitSourceService(pool, skills, versions, {
          snapshot: (config) =>
            new PublicGitHubSourceProvider(directoryGitHubFetcher(raw)).snapshot(
              config,
            ),
        });
        const source = await rawSources.create({
          ...m(),
          config: {
            repositoryUrl: `https://github.com/acme/${slug}`,
            path: `skills/${slug}`,
          },
          idempotencyKey: `source-${slug}`,
        });
        const preview = await rawSources.preview({ ...m(), sourceId: source.id });
        expect(preview.plan.map(({ path, action }) => ({ path, action }))).toEqual([
          { path: `skills/${slug}`, action: "invalid" },
        ]);
      } finally {
        rmSync(raw, { recursive: true, force: true });
      }
      const rejection = serializeWorkspaceRepository([
        {
          id: created.skill.id,
          visibility: "workspace",
          semanticVersion: "1.0.0",
          digest: created.version.digest,
          bundle,
        },
      ]);
      await expect(rejection).rejects.toBeInstanceOf(WorkspaceRepositoryError);
      await expect(rejection).rejects.toThrow(`Skill ${slug} (${created.skill.id})`);
      await expect(rejection).rejects.toThrow(rule);
    }
  });
});
