import { describe, expect, it, vi } from "vitest";
import type { AuthFnSession } from "authfn";
import type { Pool, PoolClient } from "pg";
import { ensurePersonalWorkspace } from "./tenancy.js";

describe("personal workspace provisioning", () => {
  it("does not resolve placement for an existing personal workspace", async () => {
    const statements: string[] = [];
    const client = {
      async query(text: string) {
        statements.push(text);
        if (text.includes("FROM workspaces")) {
          return { rows: [{ id: "workspace:existing" }] };
        }
        return { rows: [] };
      },
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const resolveRegion = vi.fn(() => "in-south");

    await expect(
      ensurePersonalWorkspace(
        pool,
        {
          id: "session:existing",
          actorId: "user:existing",
          subject: { email: "existing@example.test" },
        } as AuthFnSession,
        resolveRegion,
      ),
    ).resolves.toBe("workspace:existing");

    expect(resolveRegion).not.toHaveBeenCalled();
    expect(
      statements.some((statement) => statement.includes("workspace_placements")),
    ).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
