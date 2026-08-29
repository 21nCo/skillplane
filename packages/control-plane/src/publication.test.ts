import { describe, expect, it } from "vitest";
import {
  globalPublishedBundleKey,
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
});
