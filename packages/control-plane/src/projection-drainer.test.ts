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
});
