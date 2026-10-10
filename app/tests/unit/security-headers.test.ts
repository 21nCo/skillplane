import { describe, expect, it } from "vitest";
import { withBrowserSecurityHeaders } from "$lib/server/security-headers.js";

describe("browser security headers", () => {
  it("clones responses whose headers are immutable", async () => {
    const source = await fetch("data:text/plain,regional response");
    expect(() => source.headers.set("x-test", "blocked")).toThrow();

    const response = withBrowserSecurityHeaders(source);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("regional response");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
  });
});
