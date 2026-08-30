import { describe, expect, it } from "vitest";
import { hasWorkerDatabaseBinding } from "../../src/lib/server/browser-session.js";

describe("browser session database binding detection", () => {
  it("uses the in-worker API for topology gateways", () => {
    expect(
      hasWorkerDatabaseBinding({ CONTROL_HYPERDRIVE: {} } as App.Platform["env"]),
    ).toBe(true);
  });

  it("preserves legacy and direct database deployments", () => {
    expect(
      hasWorkerDatabaseBinding({ HYPERDRIVE: {} } as App.Platform["env"]),
    ).toBe(true);
    expect(
      hasWorkerDatabaseBinding({ DATABASE_URL: "postgresql://local" } as App.Platform["env"]),
    ).toBe(true);
  });

  it("falls back to HTTP outside a Worker database runtime", () => {
    expect(hasWorkerDatabaseBinding(undefined)).toBe(false);
    expect(hasWorkerDatabaseBinding({} as App.Platform["env"])).toBe(false);
  });
});
