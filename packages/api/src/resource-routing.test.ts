import { describe, expect, it, vi } from "vitest";
import { registerResourceRoutes } from "./resource-routing.js";

describe("resource route fast path", () => {
  it("does not fail a committed regional create when control is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const services = {
      controlDatabase: {
        pool: {
          query: vi.fn().mockRejectedValue(new Error("CONTROL_DATABASE_UNAVAILABLE")),
        },
      },
    };

    await expect(
      registerResourceRoutes(services as never, "workspace:one", [
        { resourceType: "skill", resourceId: "skill:one" },
      ]),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("resource_route.fast_path_failed"),
    );
    warn.mockRestore();
  });
});
