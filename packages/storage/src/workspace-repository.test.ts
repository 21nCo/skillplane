import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { createTestBundle } from "../tests/support/bundle-fixture.js";
import { canonicalizeBundle, canonicalizeBundleFiles } from "./canonicalize.js";
import { bundleJsonSchema, type CanonicalBundle } from "./manifest.js";
import { sha256Hex } from "./validate.js";
import {
  serializeWorkspaceRepository,
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
      visibility: "public",
      semanticVersion: "2.1.0",
      digest: review.digest,
      bundle: review,
    },
    {
      id: "skill:minimal",
      visibility: "private",
      semanticVersion: "1.0.0",
      digest: minimal.digest,
      bundle: minimal,
    },
    {
      id: "skill:deploy",
      visibility: "workspace",
      semanticVersion: "1.0.0-rc.1",
      digest: deploy.digest,
      bundle: deploy,
    },
  ];
  return reverse ? skills.reverse() : skills;
}

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
  });

  it("serializes an empty workspace as a manifest without skills", async () => {
    const tree = await serializeWorkspaceRepository([]);
    expect([...tree.keys()]).toEqual([".gitattributes", "skillplane.workspace.json"]);
    expect(decoder.decode(tree.get("skillplane.workspace.json"))).toBe(
      '{\n  "formatVersion": 1,\n  "skills": []\n}\n',
    );
  });
});
