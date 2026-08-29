import { describe, expect, it, vi } from "vitest";
import { drainRegionalProjectionOutbox } from "./projection-outbox.js";

function event(id: string) {
  return {
    id,
    workspace_id: `workspace:${id}`,
    event_type: "public_skill.unpublished" as const,
    payload: {
      workspaceId: `workspace:${id}`,
      skillId: `skill:${id}`,
      versionId: `version:${id}`,
    },
    fencing_epoch: 2,
    sequence: 1,
  };
}

describe("regional projection outbox drainer", () => {
  it("acknowledges claimed events only after successful projection", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return queries.length === 1
          ? { rows: [event("one")] }
          : { rows: [{ id: "one" }] };
      }),
    };
    const process = vi.fn(async () => undefined);
    await expect(
      drainRegionalProjectionOutbox({
        regionId: "in-south",
        database,
        process,
        claimToken: "claim:test",
      }),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    expect(process).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "one",
        regionId: "in-south",
        fencingEpoch: 2,
        sequence: 1,
      }),
    );
    expect(queries[0]).toContain("FOR UPDATE SKIP LOCKED");
    expect(queries[1]).toContain("processed_at = now()");
  });

  it("releases failed claims with a safe retry code", async () => {
    const values: (readonly unknown[] | undefined)[] = [];
    const database = {
      query: vi.fn(async (_text: string, parameters?: readonly unknown[]) => {
        values.push(parameters);
        return values.length === 1 ? { rows: [event("bad")] } : { rows: [] };
      }),
    };
    await expect(
      drainRegionalProjectionOutbox({
        regionId: "in-south",
        database,
        process: async () => {
          throw new Error("contains private object key / tenant name");
        },
        claimToken: "claim:test",
      }),
    ).resolves.toEqual({ processed: 0, failed: 1 });
    expect(values[1]).toEqual(["bad", "claim:test", "PUBLICATION_PROJECTION_FAILED"]);
  });

  it("does not let a delayed reclaimed unpublish clobber a later publish", async () => {
    let now = 0;
    const rows = [
      {
        ...event("unpublish"),
        workspace_id: "workspace:shared",
        payload: {
          workspaceId: "workspace:shared",
          skillId: "skill:shared",
          versionId: "version:one",
        },
        sequence: 1,
        processed: false,
        claimToken: null as string | null,
        claimedAt: null as number | null,
      },
      {
        ...event("publish"),
        workspace_id: "workspace:shared",
        event_type: "public_skill.published" as const,
        payload: {},
        sequence: 2,
        processed: false,
        claimToken: null as string | null,
        claimedAt: null as number | null,
      },
    ];
    const database = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        if (text.includes("WITH candidates AS")) {
          const leaseMs = Number(values[1]) * 1_000;
          const token = String(values[2]);
          const candidate = rows.find(
            (row) =>
              !row.processed &&
              (row.claimedAt === null || row.claimedAt < now - leaseMs) &&
              !rows.some(
                (earlier) =>
                  earlier.workspace_id === row.workspace_id &&
                  !earlier.processed &&
                  earlier.sequence < row.sequence,
              ),
          );
          if (!candidate) return { rows: [] };
          candidate.claimToken = token;
          candidate.claimedAt = now;
          return { rows: [{ ...candidate }] };
        }
        const id = String(values[0]);
        const token = String(values[1]);
        const claimed = rows.find((row) => row.id === id);
        if (text.includes("SET processed_at = now()")) {
          if (!claimed || claimed.processed || claimed.claimToken !== token) {
            return { rows: [] };
          }
          claimed.processed = true;
          claimed.claimToken = null;
          claimed.claimedAt = null;
          return { rows: [{ id }] };
        }
        if (text.includes("last_error = $3")) {
          if (claimed && !claimed.processed && claimed.claimToken === token) {
            claimed.claimToken = null;
            claimed.claimedAt = null;
          }
          return { rows: [] };
        }
        throw new Error(`Unexpected projection SQL: ${text}`);
      }),
    };

    let releaseOriginal!: () => void;
    const originalReleased = new Promise<void>((resolve) => {
      releaseOriginal = resolve;
    });
    let markOriginalStarted!: () => void;
    const originalStarted = new Promise<void>((resolve) => {
      markOriginalStarted = resolve;
    });
    let originalBlocked = true;
    const projection = { state: "published", sequence: 0 };
    const process = async (projectionEvent: {
      readonly id: string;
      readonly eventType: "public_skill.published" | "public_skill.unpublished";
      readonly sequence: number;
    }) => {
      if (projectionEvent.id === "unpublish" && originalBlocked) {
        originalBlocked = false;
        markOriginalStarted();
        await originalReleased;
      }
      if (projection.sequence > projectionEvent.sequence) return;
      projection.sequence = projectionEvent.sequence;
      projection.state =
        projectionEvent.eventType === "public_skill.published"
          ? "published"
          : "unpublished";
    };

    const originalWorker = drainRegionalProjectionOutbox({
      regionId: "in-south",
      database,
      process,
      leaseSeconds: 10,
      claimToken: "claim:original",
    });
    await originalStarted;
    now = 20_000;
    await expect(
      drainRegionalProjectionOutbox({
        regionId: "in-south",
        database,
        process,
        leaseSeconds: 10,
        claimToken: "claim:reclaimed",
      }),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    await expect(
      drainRegionalProjectionOutbox({
        regionId: "in-south",
        database,
        process,
        leaseSeconds: 10,
        claimToken: "claim:publish",
      }),
    ).resolves.toEqual({ processed: 1, failed: 0 });
    releaseOriginal();
    await expect(originalWorker).resolves.toEqual({ processed: 0, failed: 1 });
    expect(projection).toEqual({ state: "published", sequence: 2 });
  });
});
