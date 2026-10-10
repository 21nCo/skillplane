import { describe, expect, it, vi } from "vitest";
import { createPostgresRoutingReplayStore } from "./replay.js";

describe("PostgreSQL routing replay protection", () => {
  it("purges expired nonces while atomically claiming a fresh nonce", async () => {
    const query = vi.fn(async () => ({ rows: [{ nonce: "nonce:fresh" }] }));
    const store = createPostgresRoutingReplayStore({ query });
    const expiresAt = Date.now() + 60_000;

    await expect(store.claim("nonce:fresh", expiresAt)).resolves.toBe(true);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("DELETE FROM workspace_routing_nonces");
    expect(query.mock.calls[0]?.[0]).toContain("WHERE expires_at <= now()");
    expect(query.mock.calls[0]?.[1]).toEqual(["nonce:fresh", new Date(expiresAt)]);
  });

  it("rejects an already expired nonce without touching the database", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const store = createPostgresRoutingReplayStore({ query });

    await expect(store.claim("nonce:expired", Date.now() - 1)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
