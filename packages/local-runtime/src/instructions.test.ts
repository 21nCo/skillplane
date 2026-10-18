import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  LocalStore,
  LocalWorkspaceProvider,
  Runtime,
  RuntimeError,
  projectSchema,
  targetSchema,
  type CreateRequest,
} from "./index.js";
import { assertProjectionSupported } from "./projections.js";

const stores: LocalStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function root(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "skillplane-kind-")));
}

const skill: CreateRequest = {
  slug: "review",
  name: "Review",
  description: "Review changes carefully",
  tags: [],
  visibility: "private",
  instructions: "Read the changes and explain problems.",
  assets: [],
  idempotencyKey: "create-skill",
};
const instructions: CreateRequest = {
  ...skill,
  kind: "instructions",
  slug: "repository-agents",
  name: "Repository agents",
  instructions: "# Agents\n\nRun pnpm test before handing off.\n",
  idempotencyKey: "create-instructions",
};

describe("local instructions artifacts", () => {
  it("round-trips kind through the store and reviews instructions amendments", async () => {
    const state = join(root(), "state");
    const store = new LocalStore(state);
    stores.push(store);
    const provider = LocalWorkspaceProvider.create(store, "Personal");
    const created = await provider.create(instructions);
    await provider.create(skill);
    store.close();
    stores.pop();

    const reopened = new LocalStore(state);
    stores.push(reopened);
    const again = new LocalWorkspaceProvider(reopened, provider.workspace.id);
    expect((await again.list()).map((item) => [item.slug, item.kind])).toEqual([
      ["repository-agents", "instructions"],
      ["review", "skill"],
    ]);
    const snapshot = await again.retrieve(created.skillId);
    expect(snapshot.skill.kind).toBe("instructions");
    expect(new TextDecoder().decode(snapshot.bundle.files.get("AGENTS.md"))).toBe(
      instructions.instructions,
    );
    expect(() => assertProjectionSupported(snapshot.bundle)).toThrow(
      "Instructions documents are not projected as skills",
    );

    const amended = await again.amend({
      skillId: created.skillId,
      baseVersionId: created.versionId,
      proposedBump: "minor",
      idempotencyKey: "amend-instructions",
      changes: [
        {
          operation: "replace",
          path: "AGENTS.md",
          expectedSha256: createHash("sha256")
            .update(instructions.instructions)
            .digest("hex"),
          content: `${instructions.instructions}\nKeep PRs small.\n`,
        },
      ],
      learning: {
        summary: "Ask for small PRs",
        observation: "Large PRs stalled review",
        rationale: "Smaller changes review faster",
        confidence: "high",
        evidence: [],
        evidenceUnavailableReason: "Editorial update",
        validation: [],
        validationNotRunReason: "No executable change",
      },
    });
    const [candidate] = (await again.candidates(created.skillId)) as {
      reviewId: string;
      expectedUpdatedAt: string;
    }[];
    expect(candidate?.reviewId).toBe(amended.versionId);
    const published = await again.decide(
      created.skillId,
      amended.versionId,
      candidate?.expectedUpdatedAt ?? "",
      true,
      "Clearer guidance",
      "approve-instructions",
    );
    expect(published).toMatchObject({ state: "published", semanticVersion: "1.1.0" });
    expect((await again.retrieve(created.skillId)).skill.kind).toBe("instructions");
  });

  it("rejects instructions with assets as a stable validation error", async () => {
    const store = new LocalStore(join(root(), "state"));
    stores.push(store);
    const provider = LocalWorkspaceProvider.create(store, "Personal");
    const rejected = provider.create({
      ...instructions,
      assets: [{ path: "references/extra.md", content: "extra" }],
    });
    await expect(rejected).rejects.toBeInstanceOf(RuntimeError);
    await expect(rejected).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "Instructions are a single AGENTS.md document without assets or composition",
    });
    expect(await provider.list()).toEqual([]);
  });

  it("keeps kind and digest across an export and import round trip", async () => {
    const base = root();
    const store = new LocalStore(join(base, "state"));
    stores.push(store);
    const runtime = new Runtime(store);
    const source = LocalWorkspaceProvider.create(store, "Source");
    const created = await source.create(instructions);
    const snapshot = await source.retrieve(created.skillId);
    const file = join(base, "instructions.zip");
    runtime.exportBundle(snapshot, file);

    const destination = LocalWorkspaceProvider.create(store, "Destination");
    const imported = (await runtime.importBundle(
      projectSchema.parse({ formatVersion: 1, primary: destination.workspace }),
      readFileSync(file),
      "import-instructions",
    )) as { skillId: string };
    const copy = await destination.retrieve(imported.skillId);
    expect(copy.skill.kind).toBe("instructions");
    expect(copy.bundle.digest).toBe(snapshot.bundle.digest);
  });

  it("upgrades stores created before artifact kinds", async () => {
    const state = join(root(), "state");
    mkdirSync(state, { mode: 0o700 });
    const legacy = new DatabaseSync(join(state, "runtime.sqlite"));
    legacy.exec(`CREATE TABLE workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE skill (id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES workspace(id), slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, current TEXT, UNIQUE(workspace,slug));
      INSERT INTO workspace VALUES ('11111111-1111-4111-8111-111111111111', 'Legacy');
      INSERT INTO skill VALUES ('skill:legacy', '11111111-1111-4111-8111-111111111111', 'legacy', 'Legacy', '', NULL);`);
    legacy.close();
    const store = new LocalStore(state);
    stores.push(store);
    const provider = new LocalWorkspaceProvider(
      store,
      "11111111-1111-4111-8111-111111111111",
    );
    expect(await provider.list()).toEqual([
      {
        id: "skill:legacy",
        slug: "legacy",
        name: "Legacy",
        description: "",
        kind: "skill",
      },
    ]);
  });

  it("keeps the skill table writable by published runtimes", async () => {
    const store = new LocalStore(join(root(), "state"));
    stores.push(store);
    const provider = LocalWorkspaceProvider.create(store, "Personal");
    await provider.create(instructions);
    // CLI/MCP 0.1.1 inserts skill rows with six positional values.
    store.db
      .prepare("INSERT INTO skill VALUES(?,?,?,?,?,?)")
      .run("skill:published", provider.workspace.id, "older", "Older", "", null);
    expect((await provider.list()).map(({ slug, kind }) => ({ slug, kind }))).toEqual([
      { slug: "older", kind: "skill" },
      { slug: "repository-agents", kind: "instructions" },
    ]);
  });

  it("never projects instructions documents into agent skill directories", async () => {
    const base = root();
    const store = new LocalStore(join(base, "state"));
    stores.push(store);
    const runtime = new Runtime(store);
    const project = join(base, "project");
    mkdirSync(project);
    const context = runtime.setup(project, "Personal", [
      targetSchema.parse({ adapter: "codex" }),
    ]);
    const provider = new LocalWorkspaceProvider(store, context.primary.id);
    await provider.create(instructions);
    await provider.create(skill);
    expect((await runtime.catalog(context)).map((item) => item.name)).toEqual([
      "review",
    ]);
    expect((await runtime.sync(project)).map((record) => record.skill.slug)).toEqual([
      "review",
    ]);
  });
});
