import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  gitSourceConfig,
  PublicGitHubSourceProvider,
} from "../../domain/src/git-source-provider.js";
import { directoryGitHubFetcher } from "../../testing/src/git-directory.js";
import {
  CloudWorkspaceProvider,
  LocalStore,
  LocalWorkspaceProvider,
  Runtime,
  RuntimeError,
  workspaceRepository,
  writeWorkspaceRepository,
  type CloudTransport,
  type CreateRequest,
  type WorkspaceProvider,
} from "./index.js";
import { main } from "./cli.js";

const stores: LocalStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function root(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "skillplane-git-export-")));
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const learning = {
  summary: "Clarify the checklist",
  observation: "Reviewers skipped tests",
  rationale: "Explicit steps",
  confidence: "high",
  evidence: [],
  evidenceUnavailableReason: "Editorial update",
  validation: [],
  validationNotRunReason: "No executable change",
} as const;
const review: CreateRequest = {
  slug: "review",
  name: "Review",
  description: "Review changes carefully",
  tags: ["quality"],
  visibility: "private",
  instructions: "Read the changes and explain problems.",
  assets: [{ path: "references/checklist.md", content: "- Tests\n" }],
  idempotencyKey: "create-review",
};

// A local workspace with a republished skill, a pending draft, a plain skill and
// an instructions document, created through the CLI's own project setup.
async function workspace() {
  const base = root();
  const state = join(base, "state");
  const project = join(base, "project");
  mkdirSync(project);
  const store = new LocalStore(state);
  stores.push(store);
  const context = new Runtime(store).setup(project, "Personal", []);
  const provider = new LocalWorkspaceProvider(store, context.primary.id);
  const created = await provider.create(review);
  const amended = await provider.amend({
    skillId: created.skillId,
    baseVersionId: created.versionId,
    proposedBump: "minor",
    idempotencyKey: "amend-review",
    changes: [
      {
        operation: "replace",
        path: "SKILL.md",
        expectedSha256: sha256(
          new TextDecoder().decode(
            (await provider.retrieve(created.skillId)).bundle.files.get("SKILL.md"),
          ),
        ),
        content: "# Review\n\nRun the checklist first.\n",
      },
    ],
    learning,
  });
  const [candidate] = (await provider.candidates(created.skillId)) as {
    expectedUpdatedAt: string;
  }[];
  await provider.decide(
    created.skillId,
    amended.versionId,
    candidate?.expectedUpdatedAt ?? "",
    true,
    "Clearer",
    "approve-review",
  );
  const published = await provider.retrieve(created.skillId);
  await provider.amend({
    skillId: created.skillId,
    baseVersionId: amended.versionId,
    proposedBump: "patch",
    idempotencyKey: "draft-review",
    changes: [
      {
        operation: "replace",
        path: "SKILL.md",
        expectedSha256: sha256("# Review\n\nRun the checklist first.\n"),
        content: "# Review\n\nUNPUBLISHED DRAFT TEXT\n",
      },
    ],
    learning,
  });
  const plain = await provider.create({
    ...review,
    slug: "deploy",
    name: "Deploy",
    tags: [],
    assets: [],
    instructions: "Ship it.",
    idempotencyKey: "create-deploy",
  });
  await provider.create({
    ...review,
    kind: "instructions",
    slug: "repository-agents",
    name: "Repository agents",
    assets: [],
    instructions: "# Agents\n",
    idempotencyKey: "create-agents",
  });
  return { base, state, project, provider, published, plain };
}

async function cli(...args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await main(args);
    return JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
  } finally {
    log.mockRestore();
  }
}

function files(directory: string, prefix = ""): string[] {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(directory, `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    )
    .sort();
}

describe("skillplane export --git", () => {
  it("writes current published skills that the Git source importer reads back to their digests", async () => {
    const { base, state, project, provider, published, plain } = await workspace();
    const out = join(base, "repository");
    const result = await cli(
      "export",
      "--git",
      out,
      "--home",
      state,
      "--project",
      project,
    );
    expect(result).toMatchObject({ exported: true, directory: out });
    expect(files(out)).toEqual([
      ".gitattributes",
      "skillplane.workspace.json",
      "skills/deploy/SKILL.md",
      "skills/deploy/skill.json",
      "skills/review/SKILL.md",
      "skills/review/references/checklist.md",
      "skills/review/skill.json",
    ]);
    expect(result.files).toBe(7);
    const manifest = JSON.parse(
      readFileSync(join(out, "skillplane.workspace.json"), "utf8"),
    ) as { skills: Record<string, unknown>[] };
    expect(manifest.skills).toEqual([
      {
        digest: (await provider.retrieve(plain.skillId)).bundle.digest,
        id: plain.skillId,
        path: "skills/deploy",
        semanticVersion: "1.0.0",
        slug: "deploy",
        tags: [],
        visibility: "private",
      },
      {
        digest: published.bundle.digest,
        id: published.skill.id,
        path: "skills/review",
        semanticVersion: "1.1.0",
        slug: "review",
        tags: ["quality"],
        visibility: "private",
      },
    ]);
    // The pending draft and the instructions document are never exported.
    const text = files(out)
      .map((path) => readFileSync(join(out, path), "utf8"))
      .join("\n");
    expect(text).not.toContain("UNPUBLISHED DRAFT TEXT");
    expect(text).not.toContain("repository-agents");
    expect(readFileSync(join(out, "skills/review/SKILL.md"), "utf8")).toBe(
      "# Review\n\nRun the checklist first.\n",
    );

    // SKI-12 discovery and canonicalization reproduce every published digest.
    const snapshot = await new PublicGitHubSourceProvider(
      directoryGitHubFetcher(out),
    ).snapshot(gitSourceConfig({ repositoryUrl: "https://github.com/acme/skills" }));
    expect(
      snapshot.skills.map((s) => ({
        path: s.path,
        error: s.error,
        digest: s.bundle?.digest,
      })),
    ).toEqual(
      manifest.skills.map((s) => ({ path: s.path, error: null, digest: s.digest })),
    );
  });

  it("re-exports byte-identical trees in every time zone", async () => {
    const { base, provider } = await workspace();
    const original = process.env.TZ;
    const trees: ReadonlyMap<string, Uint8Array>[] = [];
    try {
      for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
        process.env.TZ = zone;
        trees.push(await workspaceRepository(provider));
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
    for (const tree of trees.slice(1)) expect(tree).toEqual(trees[0]);
    const first = join(base, "first"),
      second = join(base, "second");
    writeWorkspaceRepository(first, trees[0] ?? new Map(), false);
    writeWorkspaceRepository(second, trees[1] ?? new Map(), false);
    expect(files(second)).toEqual(files(first));
    for (const path of files(first))
      expect(readFileSync(join(second, path))).toEqual(readFileSync(join(first, path)));
  });

  it("refuses non-empty directories unless forced, then replaces only the layout's entries", async () => {
    const { base, provider } = await workspace();
    const tree = await workspaceRepository(provider);
    const out = join(base, "clone");
    mkdirSync(join(out, ".git"), { recursive: true });
    writeFileSync(join(out, ".git", "HEAD"), "ref: refs/heads/main\n");
    // A repository holding only .git is still empty for export purposes.
    writeWorkspaceRepository(out, tree, false);
    expect(() => writeWorkspaceRepository(out, tree, false)).toThrow(
      expect.objectContaining({ code: "EXPORT_EXISTS" }),
    );
    writeFileSync(join(out, "README.md"), "Team skills\n");
    mkdirSync(join(out, "skills", "removed"), { recursive: true });
    writeFileSync(join(out, "skills", "removed", "SKILL.md"), "# Stale\n");
    writeFileSync(join(out, "skills", "review", "SKILL.md"), "# Locally edited\n");
    writeWorkspaceRepository(out, tree, true);
    expect(files(out)).toEqual([
      ".git/HEAD",
      ".gitattributes",
      "README.md",
      "skillplane.workspace.json",
      ...[...tree.keys()].filter((path) => path.startsWith("skills/")),
    ]);
    expect(readFileSync(join(out, "skills", "review", "SKILL.md"))).toEqual(
      Buffer.from(tree.get("skills/review/SKILL.md") ?? new Uint8Array()),
    );

    const file = join(base, "file");
    writeFileSync(file, "not a directory");
    expect(() => writeWorkspaceRepository(file, tree, true)).toThrow(
      expect.objectContaining({ code: "UNSAFE_DIRECTORY" }),
    );
    const link = join(base, "link");
    symlinkSync(out, link);
    expect(() => writeWorkspaceRepository(link, tree, true)).toThrow(
      expect.objectContaining({ code: "UNSAFE_DIRECTORY" }),
    );
  });

  it("validates arguments and writes nothing when a skill changes during export", async () => {
    const { base, state, project, provider } = await workspace();
    const run = (...args: string[]) =>
      main([...args, "--home", state, "--project", project]);
    await expect(
      run("export", "--git", join(base, "x"), "skill:extra"),
    ).rejects.toThrow(RuntimeError);
    await expect(run("export", "--force", "skill:1", join(base, "y"))).rejects.toThrow(
      RuntimeError,
    );
    await expect(run("list", "--git", join(base, "z"))).rejects.toThrow(RuntimeError);
    await expect(run("export", "--git")).rejects.toMatchObject({
      code: "ARGUMENT_REQUIRED",
    });
    for (const path of ["x", "y", "z"])
      expect(existsSync(join(base, path))).toBe(false);

    const racing: WorkspaceProvider = Object.assign(Object.create(provider) as object, {
      retrieve: async (id: string) => {
        const snapshot = await provider.retrieve(id);
        return {
          ...snapshot,
          version: { ...snapshot.version, id: "skill-version:new" },
        };
      },
    }) as WorkspaceProvider;
    await expect(workspaceRepository(racing)).rejects.toMatchObject({
      code: "EXPORT_STATE_CHANGED",
    });
  });

  it("selects active cloud skills with a published version in every visibility", async () => {
    const listed = (
      id: string,
      visibility: string,
      currentVersion: { id: string; semanticVersion: string } | null,
      archivedAt: string | null = null,
    ) => ({
      id,
      workspaceId: "workspace:1",
      workspaceSlug: "work",
      slug: id.replace("skill:", ""),
      name: id,
      summary: "",
      tags: [],
      visibility,
      currentVersion,
      archivedAt,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const args: Record<string, unknown>[] = [];
    const transport: CloudTransport = {
      call: (name, input) => {
        args.push(input);
        if (name !== "skills_list") throw new Error(`Unexpected ${name}`);
        return Promise.resolve({
          requestId: "request",
          workspace: {
            id: "workspace:1",
            slug: "work",
            name: "Work",
            kind: "personal",
          },
          skills: [
            listed("skill:private", "private", { id: "v:1", semanticVersion: "1.0.0" }),
            listed("skill:shared", "workspace", {
              id: "v:2",
              semanticVersion: "2.0.0",
            }),
            listed("skill:public", "public", { id: "v:3", semanticVersion: "1.2.0" }),
            listed("skill:unpublished", "private", null),
            listed(
              "skill:archived",
              "public",
              { id: "v:4", semanticVersion: "1.0.0" },
              "2026-01-02T00:00:00.000Z",
            ),
          ],
          nextCursor: null,
        });
      },
      download: () => Promise.reject(new Error("No download expected")),
    };
    const cloud = new CloudWorkspaceProvider(
      {
        provider: "cloud",
        profile: "work",
        endpoint: "https://mcp.example.com/mcp",
        id: "workspace:1",
      },
      transport,
    );
    expect(await cloud.publishedSkills()).toEqual([
      { id: "skill:private", versionId: "v:1", visibility: "private" },
      { id: "skill:shared", versionId: "v:2", visibility: "workspace" },
      { id: "skill:public", versionId: "v:3", visibility: "public" },
    ]);
    // Only skills are listed; instructions documents need an explicit kind.
    expect(args[0]).not.toHaveProperty("kind");
  });
});
