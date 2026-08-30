import { describe, expect, it } from "vitest";
import { createMemoryWorkspacePlacementDirectory } from "./placement.js";
import { applyRegionalPublicProjection } from "./projection-outbox.js";
import type {
  ImmutablePublicationStore,
  PublicProjectionDirectory,
} from "./publication.js";

async function digest(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${[...value].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function store(): ImmutablePublicationStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putIfAbsent({ key, bytes }) {
      if (objects.has(key)) return "exists";
      objects.set(key, bytes.slice());
      return "created";
    },
    async read({ key }) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error("missing");
      return bytes.slice();
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

describe("regional publication projection", () => {
  it("copies current-epoch publication events to global storage", async () => {
    const placements = createMemoryWorkspacePlacementDirectory();
    await placements.putIfAbsent({
      namespace: "workspace:a",
      regionId: "in-south",
      epoch: 2,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
    const regionalStore = store();
    const publicStore = store();
    const bytes = new TextEncoder().encode("bundle");
    const sha = await digest(bytes);
    regionalStore.objects.set("source.zip", bytes);
    const published: unknown[] = [];
    const directory: PublicProjectionDirectory = {
      async publish(value) {
        published.push(value);
      },
      unpublish() {
        return Promise.resolve();
      },
    };
    await applyRegionalPublicProjection({
      event: {
        id: "event:1",
        regionId: "in-south",
        eventType: "public_skill.published",
        workspaceId: "workspace:a",
        fencingEpoch: 2,
        sequence: 1,
        payload: {
          workspaceId: "workspace:a",
          skillId: "skill:a",
          skillSlug: "review",
          versionId: "version:a",
          currentVersionId: "version:a",
          semanticVersion: "1.0.0",
          sourceObjectKey: "source.zip",
          digest: sha,
          publishedAt: "2026-08-01T00:00:00.000Z",
          searchText: "review carefully",
          document: { skill: { id: "skill:a" } },
        },
      },
      placements,
      resolveWorkspaceSlug: async () => "acme",
      regionalStore,
      publicStore,
      directory,
    });
    expect(published).toEqual([
      expect.objectContaining({ publishedAt: "2026-08-01T00:00:00.000Z" }),
    ]);
  });

  it("rejects events from a stale placement epoch", async () => {
    const placements = createMemoryWorkspacePlacementDirectory();
    await placements.putIfAbsent({
      namespace: "workspace:a",
      regionId: "us-east",
      epoch: 3,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
    const empty = store();
    await expect(
      applyRegionalPublicProjection({
        event: {
          id: "event:stale",
          regionId: "in-south",
          eventType: "public_skill.published",
          workspaceId: "workspace:a",
          fencingEpoch: 2,
          sequence: 1,
          payload: {},
        },
        placements,
        resolveWorkspaceSlug: async () => "acme",
        regionalStore: empty,
        publicStore: empty,
        directory: {
          publish() {
            return Promise.resolve();
          },
          unpublish() {
            return Promise.resolve();
          },
        },
      }),
    ).rejects.toThrow("PUBLICATION_FENCING_EPOCH_STALE");
  });

  it("settles source-epoch events while that source is being quiesced", async () => {
    const placements = createMemoryWorkspacePlacementDirectory();
    await placements.putIfAbsent({
      namespace: "workspace:moving",
      regionId: "in-south",
      epoch: 3,
      state: "moving",
      movingToRegionId: "us-east",
      previousRegionId: "in-south",
      updatedAt: new Date().toISOString(),
      migration: {
        phase: "moving",
        sourceRegionId: "in-south",
        targetRegionId: "us-east",
        sourceEpoch: 2,
        movingEpoch: 3,
        recoveryFence: 3,
        recoveryOwnerId: "migration:test",
        recoveryLeaseExpiresAt: Date.now() + 60_000,
      },
    });
    const unpublished: unknown[] = [];
    const empty = store();

    await expect(
      applyRegionalPublicProjection({
        event: {
          id: "event:moving-source",
          regionId: "in-south",
          eventType: "public_skill.unpublished",
          workspaceId: "workspace:moving",
          fencingEpoch: 2,
          sequence: 1,
          payload: {
            workspaceId: "workspace:moving",
            skillId: "skill:moving",
            versionId: "version:moving",
          },
        },
        placements,
        resolveWorkspaceSlug: async () => "moving",
        regionalStore: empty,
        publicStore: empty,
        directory: {
          publish: async () => undefined,
          async unpublish(value) {
            unpublished.push(value);
          },
        },
      }),
    ).resolves.toEqual({ objectKey: null });
    expect(unpublished).toHaveLength(1);
  });

  it("removes global metadata for a current-epoch unpublish event", async () => {
    const placements = createMemoryWorkspacePlacementDirectory();
    await placements.putIfAbsent({
      namespace: "workspace:a",
      regionId: "in-south",
      epoch: 4,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
    const unpublished: unknown[] = [];
    const empty = store();
    await expect(
      applyRegionalPublicProjection({
        event: {
          id: "event:unpublish",
          regionId: "in-south",
          eventType: "public_skill.unpublished",
          workspaceId: "workspace:a",
          fencingEpoch: 4,
          sequence: 7,
          payload: {
            workspaceId: "workspace:a",
            skillId: "skill:a",
            versionId: "version:a",
          },
        },
        placements,
        resolveWorkspaceSlug: async () => "acme",
        regionalStore: empty,
        publicStore: empty,
        directory: {
          publish() {
            return Promise.resolve();
          },
          unpublish(value) {
            unpublished.push(value);
            return Promise.resolve();
          },
        },
      }),
    ).resolves.toEqual({ objectKey: null });
    expect(unpublished).toEqual([
      {
        workspaceId: "workspace:a",
        skillId: "skill:a",
        versionId: "version:a",
        projectionSequence: 7,
      },
    ]);
  });

  it("projects regional skill-use counters into the global authority", async () => {
    const placements = createMemoryWorkspacePlacementDirectory();
    await placements.putIfAbsent({
      namespace: "workspace:a",
      regionId: "in-south",
      epoch: 5,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
    const increments: unknown[] = [];
    const empty = store();
    await expect(
      applyRegionalPublicProjection({
        event: {
          id: "event:stats",
          regionId: "in-south",
          eventType: "public_stats.agent_skill_used",
          workspaceId: "workspace:a",
          fencingEpoch: 5,
          sequence: 1,
          payload: { workspaceId: "workspace:a", count: 1 },
        },
        placements,
        resolveWorkspaceSlug: async () => "acme",
        regionalStore: empty,
        publicStore: empty,
        directory: {
          publish: async () => undefined,
          unpublish: async () => undefined,
        },
        async applyPublicStats(input) {
          increments.push(input);
        },
      }),
    ).resolves.toEqual({ objectKey: null });
    expect(increments).toEqual([
      {
        eventId: "event:stats",
        workspaceId: "workspace:a",
        eventType: "public_stats.agent_skill_used",
        agentSkillUses: 1,
        totalSkills: 0,
      },
    ]);
  });

  it("projects regional resource IDs into the global routing directory", async () => {
    const placements = createMemoryWorkspacePlacementDirectory();
    await placements.putIfAbsent({
      namespace: "workspace:a",
      regionId: "eu-west",
      epoch: 6,
      state: "active",
      updatedAt: new Date().toISOString(),
    });
    const routes: unknown[] = [];
    const empty = store();

    await expect(
      applyRegionalPublicProjection({
        event: {
          id: "event:route",
          regionId: "eu-west",
          eventType: "resource_route.upsert",
          workspaceId: "workspace:a",
          fencingEpoch: 6,
          sequence: 2,
          payload: {
            workspaceId: "workspace:a",
            resources: [
              { resourceType: "context", resourceId: "context:a" },
              { resourceType: "context_note", resourceId: "note:a" },
            ],
          },
        },
        placements,
        resolveWorkspaceSlug: async () => "acme",
        regionalStore: empty,
        publicStore: empty,
        directory: {
          publish: async () => undefined,
          unpublish: async () => undefined,
        },
        resourceDirectory: {
          resolve: async () => null,
          async upsert(route) {
            routes.push(route);
          },
          tombstone: async () => undefined,
        },
      }),
    ).resolves.toEqual({ objectKey: null });
    expect(routes).toEqual([
      {
        workspaceId: "workspace:a",
        resourceType: "context",
        resourceId: "context:a",
      },
      {
        workspaceId: "workspace:a",
        resourceType: "context_note",
        resourceId: "note:a",
      },
    ]);
  });
});
