import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { createTestBundle } from "../tests/support/bundle-fixture.js";
import { canonicalizeBundle, canonicalizeBundleFiles } from "./canonicalize.js";
import { bundleJsonSchema, type CanonicalBundle } from "./manifest.js";
import { sha256Hex } from "./validate.js";
import {
  gitControlPathProblem,
  serializeWorkspaceRepository,
  unrepresentableTreeProblem,
  WorkspaceRepositoryError,
  type WorkspaceRepositorySkill,
} from "./workspace-repository.js";

const decoder = new TextDecoder();

async function fixtures(mtime = new Date("2024-03-05T12:34:00Z"), reverse = false) {
  const review = await canonicalizeBundle(
    await createTestBundle(
      {
        "SKILL.md": "# Pull request review\r\n\r\nReview for correctness.\r\n",
        "references/checklist.md": "- Tests\n- Security\n",
        "scripts/check.sh": "#!/bin/sh\nexit 0\n",
      },
      {
        name: "PR review",
        slug: "pr-review",
        tags: ["security", "review"],
        mtime,
        ...(reverse
          ? { order: ["scripts/check.sh", "references/checklist.md", "SKILL.md"] }
          : {}),
      },
    ),
  );
  const minimal = await canonicalizeBundle(
    await createTestBundle(
      { "SKILL.md": "# Minimal skill\n" },
      { name: "Minimal skill", slug: "minimal-skill", tags: [], mtime },
    ),
  );
  const deploy = await canonicalizeBundle(
    await createTestBundle(
      { "SKILL.md": "# Deploy\n", "assets/diagram.txt": "build -> ship\n" },
      { name: "Deploy", slug: "deploy", tags: ["ops"], mtime },
    ),
  );
  const skills: WorkspaceRepositorySkill[] = [
    {
      id: "skill:review",
      slug: "pr-review",
      visibility: "public",
      semanticVersion: "2.1.0",
      digest: review.digest,
      bundle: review,
    },
    {
      id: "skill:minimal",
      slug: "minimal-skill",
      visibility: "private",
      semanticVersion: "1.0.0",
      digest: minimal.digest,
      bundle: minimal,
    },
    {
      id: "skill:deploy",
      slug: "deploy",
      visibility: "workspace",
      semanticVersion: "1.0.0-rc.1",
      digest: deploy.digest,
      bundle: deploy,
    },
  ];
  return reverse ? skills.reverse() : skills;
}

/** A published skill whose bundle holds exactly these extra files besides SKILL.md. */
async function publishedWith(
  slug: string,
  files: Record<string, string>,
): Promise<WorkspaceRepositorySkill> {
  const bundle = await canonicalizeBundleFiles({
    skill: {
      formatVersion: 1,
      entrypoint: "SKILL.md",
      name: slug,
      slug,
      description: "Exported workflow",
      tags: [],
    },
    files: new Map(
      Object.entries({ "SKILL.md": `# ${slug}\n`, ...files }).map(([path, text]) => [
        path,
        strToU8(text),
      ]),
    ),
  });
  return {
    id: `skill:${slug}`,
    slug,
    visibility: "private",
    semanticVersion: "1.0.0",
    digest: bundle.digest,
    bundle,
  };
}

/** `count` asset files with distinct contents. */
const distinctAssets = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `assets/${String(index)}.txt`,
      `${String(index)}\n`,
    ]),
  );

async function digests(tree: ReadonlyMap<string, Uint8Array>) {
  const result: Record<string, string> = {};
  for (const [path, bytes] of tree) result[path] = await sha256Hex(bytes);
  return result;
}

const expectedManifest = `{
  "formatVersion": 1,
  "skills": [
    {
      "digest": "DEPLOY",
      "id": "skill:deploy",
      "path": "skills/deploy",
      "semanticVersion": "1.0.0-rc.1",
      "slug": "deploy",
      "tags": [
        "ops"
      ],
      "visibility": "workspace"
    },
    {
      "digest": "MINIMAL",
      "id": "skill:minimal",
      "path": "skills/minimal-skill",
      "semanticVersion": "1.0.0",
      "slug": "minimal-skill",
      "tags": [],
      "visibility": "private"
    },
    {
      "digest": "REVIEW",
      "id": "skill:review",
      "path": "skills/pr-review",
      "semanticVersion": "2.1.0",
      "slug": "pr-review",
      "tags": [
        "review",
        "security"
      ],
      "visibility": "public"
    }
  ]
}
`;

describe("workspace repository serializer", () => {
  it("renders the golden layout and skillplane.workspace.json shape", async () => {
    const skills = await fixtures();
    const tree = await serializeWorkspaceRepository(skills);
    expect([...tree.keys()]).toEqual([
      ".gitattributes",
      "skillplane.workspace.json",
      "skills/deploy/SKILL.md",
      "skills/deploy/assets/diagram.txt",
      "skills/deploy/skill.json",
      "skills/minimal-skill/SKILL.md",
      "skills/minimal-skill/skill.json",
      "skills/pr-review/SKILL.md",
      "skills/pr-review/references/checklist.md",
      "skills/pr-review/scripts/check.sh",
      "skills/pr-review/skill.json",
    ]);
    expect(decoder.decode(tree.get(".gitattributes"))).toBe("* -text\n");
    const [review, minimal, deploy] = skills;
    expect(decoder.decode(tree.get("skillplane.workspace.json"))).toBe(
      expectedManifest
        .replace("DEPLOY", deploy?.digest ?? "")
        .replace("MINIMAL", minimal?.digest ?? "")
        .replace("REVIEW", review?.digest ?? ""),
    );
    // Bundle bytes are exported verbatim, including CRLF content.
    expect(decoder.decode(tree.get("skills/pr-review/SKILL.md"))).toBe(
      "# Pull request review\r\n\r\nReview for correctness.\r\n",
    );
    // Golden content digests fix every exported byte, including skill.json.
    expect(await digests(tree)).toEqual({
      ".gitattributes":
        "705fd4d6451a31d36b3df7de96f83f30ac976c9b4a6d1e51671d8e2f33e2d0da",
      "skillplane.workspace.json":
        "cbeb55bf84c812222414ff07a28215ac16556151249644c8477983e7676edc4e",
      "skills/deploy/SKILL.md":
        "664c1b86c845c45e999e104a20db0eb728ca92ecbc748e94f36f1484621d8c88",
      "skills/deploy/assets/diagram.txt":
        "3f01587807a8449c901b722c39b83ec3161ce0ea44c37a46a779afb813357436",
      "skills/deploy/skill.json":
        "0be21787680a81d2c129d60bc5d0adff2ed5e93a0a4e02911e6cdbf3d5fbe42e",
      "skills/minimal-skill/SKILL.md":
        "d805e898c2eaad8fca1a34e07defbd381efaf65e183247ac90e87692980e8428",
      "skills/minimal-skill/skill.json":
        "0f7c455bbfbde6eceab0c17f421aaf7fdc7f20e0a9ecfd9cf6ffb9721e747bbe",
      "skills/pr-review/SKILL.md":
        "226d64c4d01e5a2fdca700628ef43cd554040803b666ee34549d7695be38a7e6",
      "skills/pr-review/references/checklist.md":
        "416b27d831df5a9fdd96395a0462d0b5faf20fa13b92a72aeea8955f1fb1aaea",
      "skills/pr-review/scripts/check.sh":
        "306c6ca7407560340797866e077e053627ad409277d1b9da58106fce4cf717cb",
      "skills/pr-review/skill.json":
        "ba0c5a4c1c57496715d9fe4af72e1bbf9b6744eda69109ef87266cffaf271ccf",
    });
  });

  it("produces byte-identical trees regardless of input order, archive timestamps and time zone", async () => {
    const expected = await serializeWorkspaceRepository(await fixtures());
    const original = process.env.TZ;
    try {
      for (const zone of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
        process.env.TZ = zone;
        const tree = await serializeWorkspaceRepository(
          await fixtures(new Date("2031-11-02T01:30:00Z"), true),
        );
        expect([...tree.keys()]).toEqual([...expected.keys()]);
        for (const [path, bytes] of expected) expect(tree.get(path)).toEqual(bytes);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it("exports skill directories that canonicalize to each published digest", async () => {
    const skills = await fixtures();
    const tree = await serializeWorkspaceRepository(skills);
    const manifest = JSON.parse(
      decoder.decode(tree.get("skillplane.workspace.json")),
    ) as { skills: { id: string; path: string; digest: string }[] };
    expect(manifest.skills).toHaveLength(skills.length);
    for (const entry of manifest.skills) {
      const files = new Map<string, Uint8Array>();
      for (const [path, bytes] of tree)
        if (path.startsWith(`${entry.path}/`))
          files.set(path.slice(entry.path.length + 1), bytes);
      const skill = bundleJsonSchema.parse(
        JSON.parse(decoder.decode(files.get("skill.json"))),
      );
      const bundle = await canonicalizeBundleFiles({ skill, files });
      const published = skills.find((s) => s.id === entry.id);
      expect(bundle.digest).toBe(published?.digest);
      expect(entry.digest).toBe(published?.digest);
    }
  });

  it("writes only the documented manifest fields, never workspace secrets or drafts", async () => {
    const [skill] = await fixtures();
    if (!skill) throw new Error("fixture missing");
    const leaked = {
      ...skill,
      members: [{ email: "owner@example.com", role: "owner" }],
      credentials: { token: "spk_sentinel_secret" },
      analytics: { invocations: 42 },
      drafts: [{ id: "skill-version:draft", status: "pending_review" }],
      auditEvents: [{ eventType: "skill.created" }],
    } as WorkspaceRepositorySkill;
    const tree = await serializeWorkspaceRepository([leaked]);
    const manifest = JSON.parse(
      decoder.decode(tree.get("skillplane.workspace.json")),
    ) as Record<string, unknown> & { skills: Record<string, unknown>[] };
    expect(Object.keys(manifest).sort()).toEqual(["formatVersion", "skills"]);
    expect(Object.keys(manifest.skills[0] ?? {}).sort()).toEqual([
      "digest",
      "id",
      "path",
      "semanticVersion",
      "slug",
      "tags",
      "visibility",
    ]);
    const text = [...tree.values()].map((bytes) => decoder.decode(bytes)).join("\n");
    for (const sentinel of [
      "owner@example.com",
      "spk_sentinel_secret",
      "invocations",
      "skill-version:draft",
      "pending_review",
      "skill.created",
    ])
      expect(text).not.toContain(sentinel);
  });

  it("rejects input that would not round-trip or would collide", async () => {
    const [review, minimal] = await fixtures();
    if (!review || !minimal) throw new Error("fixture missing");
    const instructions = await canonicalizeBundleFiles({
      skill: {
        formatVersion: 1,
        kind: "instructions",
        entrypoint: "AGENTS.md",
        name: "Agents",
        slug: "agents",
        description: "Shared guidance",
        tags: [],
      },
      files: new Map([["AGENTS.md", strToU8("# Agents\n")]]),
    });
    const tampered: CanonicalBundle = {
      ...review.bundle,
      files: new Map([
        ...review.bundle.files,
        ["SKILL.md", strToU8("# Edited after publication\n")],
      ]),
    };
    const cases: [string, WorkspaceRepositorySkill[]][] = [
      ["duplicate id", [review, { ...minimal, id: review.id }]],
      [
        "duplicate slug",
        [review, { ...review, id: "skill:copy", visibility: "private" }],
      ],
      [
        "instructions",
        [{ ...review, bundle: instructions, digest: instructions.digest }],
      ],
      ["recorded digest", [{ ...review, digest: minimal.digest }]],
      ["tampered files", [{ ...review, bundle: tampered }]],
      ["missing version", [{ ...review, semanticVersion: "" }]],
      ["invalid version", [{ ...review, semanticVersion: "v1" }]],
      [
        "visibility",
        [{ ...review, visibility: "secret" as WorkspaceRepositorySkill["visibility"] }],
      ],
      ["control id", [{ ...review, id: "skill:\nreview" }]],
    ];
    for (const [label, input] of cases)
      await expect(serializeWorkspaceRepository(input), label).rejects.toBeInstanceOf(
        WorkspaceRepositoryError,
      );
    // The importer compares a bound skill's slug with the bundle's, so a
    // published bundle that declares another slug is refused, not rewritten.
    await expect(
      serializeWorkspaceRepository([{ ...review, slug: "renamed" }]),
    ).rejects.toThrow(
      'Skill skill:review cannot be exported because its published bundle declares the slug pr-review, not the workspace slug "renamed"',
    );
  });

  it("refuses Git control files and their aliases at any depth", async () => {
    for (const path of [
      "assets/.git/HEAD",
      "assets/.GIT/config",
      "assets/git~1/HEAD",
      "references/.git./HEAD",
      "references/.git::$INDEX_ALLOCATION/HEAD",
      "templates/.g\u200cit/HEAD",
      "assets/.gitignore",
      "references/nested/.gitattributes",
      "scripts/.GitModules",
      "assets/gitmod~1",
    ]) {
      const skill = await publishedWith("controlled", { [path]: "*.txt text\n" });
      const rejection = serializeWorkspaceRepository([skill]);
      await expect(rejection, path).rejects.toBeInstanceOf(WorkspaceRepositoryError);
      await expect(rejection, path).rejects.toThrow(
        `Skill controlled (skill:controlled) cannot be exported because ${path} is a Git control path`,
      );
    }
    expect(gitControlPathProblem("assets/.github/workflow.yml")).toBeNull();
    expect(gitControlPathProblem("references/gitignore.md")).toBeNull();
    expect(gitControlPathProblem("assets/.gitkeep")).toBeNull();
  });

  it("refuses skills that the Git source importer would reject or that cannot be written as a tree", async () => {
    // Built at run time so the fixture is not itself a credential-shaped literal.
    const accessKey = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const privateKey = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
    const cases: [string, Record<string, string>, string][] = [
      [
        "nested",
        { "templates/SKILL.md": "# Template\n" },
        "skills/nested/templates/SKILL.md would be discovered as a nested skill root",
      ],
      // Git records a directory named SKILL.md as a tree entry, which the
      // importer discovers as a root just like a file.
      [
        "skill-md-directory",
        { "templates/SKILL.md/example.txt": "Example\n" },
        "skills/skill-md-directory/templates/SKILL.md would be discovered as a nested skill root",
      ],
      [
        "deep-skill-md-directory",
        { "assets/x/SKILL.md/y.txt": "y\n" },
        "skills/deep-skill-md-directory/assets/x/SKILL.md would be discovered",
      ],
      ["access-key", { "references/env.md": `key=${accessKey}\n` }, "credential"],
      ["private-key", { "scripts/deploy.sh": `${privateKey}\n` }, "credential"],
      ["too-many-files", distinctAssets(196), "more than 197 distinct files"],
      [
        "file-and-directory",
        { "assets/a": "file\n", "assets/a/b.txt": "child\n" },
        "both a file and a directory",
      ],
      [
        "case-directories",
        { "assets/A/x.txt": "x\n", "assets/a/y.txt": "y\n" },
        "differ only by case",
      ],
    ];
    for (const [slug, files, rule] of cases) {
      const skill = await publishedWith(slug, files);
      const minimal = await publishedWith("minimal", {});
      const rejection = serializeWorkspaceRepository([minimal, skill]);
      await expect(rejection, slug).rejects.toBeInstanceOf(WorkspaceRepositoryError);
      await expect(rejection, slug).rejects.toThrow(`Skill ${slug} (skill:${slug})`);
      await expect(rejection, slug).rejects.toThrow(rule);
    }
    // The importer limit counts distinct contents, so SKILL.md, skill.json,
    // 194 distinct assets and one repeated reference fit exactly.
    const boundary = await publishedWith("boundary", {
      ...distinctAssets(194),
      ...Object.fromEntries(
        Array.from({ length: 50 }, (_, index) => [
          `references/${String(index)}.md`,
          "same\n",
        ]),
      ),
      "references/same.md": "same\n",
    });
    expect(
      (await serializeWorkspaceRepository([boundary])).has(
        "skills/boundary/assets/193.txt",
      ),
    ).toBe(true);
  });

  it("reports paths that cannot coexist in one directory tree", () => {
    expect(unrepresentableTreeProblem(["skills/a/SKILL.md", "skills/b/SKILL.md"])).toBe(
      null,
    );
    expect(unrepresentableTreeProblem(["skills/a", "skills/a/SKILL.md"])).toContain(
      "both a file and a directory",
    );
    expect(unrepresentableTreeProblem(["skills/a/SKILL.md", "skills/a"])).toContain(
      "both a file and a directory",
    );
    expect(unrepresentableTreeProblem(["skills/É/x", "skills/é/y"])).toContain(
      "differ only by case",
    );
  });

  it("serializes an empty workspace as a manifest without skills", async () => {
    const tree = await serializeWorkspaceRepository([]);
    expect([...tree.keys()]).toEqual([".gitattributes", "skillplane.workspace.json"]);
    expect(decoder.decode(tree.get("skillplane.workspace.json"))).toBe(
      '{\n  "formatVersion": 1,\n  "skills": []\n}\n',
    );
  });
});
