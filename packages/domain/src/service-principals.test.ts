import { describe, expect, it } from "vitest";
import {
  assertServicePrincipalActive,
  parseServicePrincipalScopes,
} from "./service-principals.js";

describe("service principals", () => {
  it("deduplicates and validates explicit scopes", () => {
    expect(
      parseServicePrincipalScopes(["skills:read", "skills:amend", "skills:read"]),
    ).toEqual(["skills:amend", "skills:read"]);
    expect(() => parseServicePrincipalScopes(["workspace:owner"])).toThrow("invalid");
  });

  it("denies revoked, expired, and over-scoped credentials immediately", () => {
    const now = new Date("2026-07-25T06:00:00.000Z");
    expect(() =>
      assertServicePrincipalActive({
        revokedAt: null,
        expiresAt: null,
        requiredScope: "skills:read",
        scopes: ["skills:read"],
        now,
      }),
    ).not.toThrow();
    expect(() =>
      assertServicePrincipalActive({
        revokedAt: now,
        expiresAt: null,
        scopes: ["skills:read"],
        now,
      }),
    ).toThrow("invalid");
    expect(() =>
      assertServicePrincipalActive({
        revokedAt: null,
        expiresAt: null,
        requiredScope: "audit:read",
        scopes: ["skills:read"],
        now,
      }),
    ).toThrow("required scope");
  });
});
