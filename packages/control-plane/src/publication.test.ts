import { describe, expect, it } from "vitest";
import {
  globalPublishedBundleKey,
  PostgresPublicProjectionDirectory,
  publishGlobalProjection,
  type ImmutablePublicationStore,
  type PublicProjectionDirectory,
} from "./publication.js";

async function digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...value]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function store(): ImmutablePublicationStore & {
  readonly objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putIfAbsent(input) {
      if (objects.has(input.key)) return "exists";
      objects.set(input.key, input.bytes.slice());
      return "created";
    },
    async read(input) {
      const bytes = objects.get(input.key);
      if (!bytes) throw new Error("not found");
      if ((await digest(bytes)) !== input.digest) throw new Error("digest mismatch");
      return bytes.slice();
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

describe("global public projection", () => {
  it("copies and verifies a regional bundle before exposing metadata", async () => {
    const source = store();
    const destination = store();
    const bytes = new TextEncoder().encode("canonical bundle");
    const sha = await digest(bytes);
    source.objects.set("regional/source.zip", bytes);
    const published: Parameters<PublicProjectionDirectory["publish"]>[0][] = [];
    const directory: PublicProjectionDirectory = {
      async publish(input) {
        published.push(input);
      },
      unpublish() {
        return Promise.resolve();
      },
    };
    const key = await publishGlobalProjection({
      source,
      destination,
      directory,
      sourceKey: "regional/source.zip",
      workspaceId: "workspace:a",
      workspaceSlug: "acme",
      skillId: "skill:a",
      skillSlug: "review",
      versionId: "skill-version:a",
      semanticVersion: "1.0.0",
      digest: sha,
      projectionSequence: 3,
    });
    expect(key).toBe(
      globalPublishedBundleKey({
        workspaceId: "workspace:a",
        skillId: "skill:a",
        versionId: "skill-version:a",
        digest: sha,
      }),
    );
    expect(destination.objects.get(key)).toEqual(bytes);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ objectKey: key, digest: sha });
  });

  it("guards publish and unpublish writes with the regional event sequence", async () => {
    const calls: { readonly text: string; readonly values?: readonly unknown[] }[] = [];
    const directory = new PostgresPublicProjectionDirectory({
      async query(text, values) {
        calls.push({ text, ...(values ? { values } : {}) });
        return {};
      },
    });
    const digestValue = `sha256:${"a".repeat(64)}` as const;
    await directory.publish({
      workspaceId: "workspace:a",
      workspaceSlug: "acme",
      skillId: "skill:a",
      skillSlug: "review",
      versionId: "version:a",
      semanticVersion: "1.0.0",
      digest: digestValue,
      objectKey: "public/review.zip",
      projectionSequence: 9,
    });
    await directory.unpublish({
      workspaceId: "workspace:a",
      skillId: "skill:a",
      versionId: "version:a",
      projectionSequence: 8,
    });

    expect(calls[0]?.text).toContain(
      "public_skill_projections.projection_sequence <=",
    );
    expect(calls[0]?.values?.[8]).toBe(9);
    expect(calls[1]?.text).toContain("projection_sequence <= $3");
    expect(calls[1]?.values).toEqual(["workspace:a", "skill:a", 8]);
  });
});
