import { authorize, canPerform, type ServicePrincipal } from "@skillplane/domain";
import { describe, expect, it } from "vitest";
import { enforceCookieCsrf } from "../../src/middleware/authentication.js";
import { requiredAction } from "../../src/middleware/authorization.js";
import { rateLimitRouteKey } from "../../src/middleware/rate-limit.js";
import {
  createOpaqueToken,
  decryptEmail,
  encryptEmail,
  hashEmail,
  hashOpaqueToken,
} from "../../src/tenancy-crypto.js";

const servicePrincipal: ServicePrincipal = {
  kind: "service",
  actorId: "service-principal:reviewbot",
  servicePrincipalId: "service-principal:reviewbot",
  workspaceId: "workspace:a",
  role: "editor",
  scopes: ["skills:read", "skills:amend"],
};

describe("tenancy security", () => {
  it("requires cookie-authenticated mutations to carry the matching CSRF token", () => {
    const missing = new Request("https://skillplane.dev/api/v1/workspaces", {
      method: "POST",
      headers: { cookie: "skillplane.csrf=expected" },
    });
    expect(() => enforceCookieCsrf(missing, true, false)).toThrow(
      "could not be verified",
    );

    const mismatched = new Request("https://skillplane.dev/api/v1/workspaces", {
      method: "POST",
      headers: {
        cookie: "skillplane.csrf=expected",
        "x-authfn-csrf": "different",
      },
    });
    expect(() => enforceCookieCsrf(mismatched, true, false)).toThrow(
      "could not be verified",
    );

    const valid = new Request("https://skillplane.dev/api/v1/workspaces", {
      method: "POST",
      headers: {
        cookie: "skillplane.csrf=expected",
        "x-authfn-csrf": "expected",
      },
    });
    expect(() => enforceCookieCsrf(valid, true, false)).not.toThrow();

    const bearerWithVictimCookie = new Request(
      "https://skillplane.dev/api/v1/workspaces",
      {
        method: "POST",
        headers: {
          authorization: "Bearer attacker-controlled",
          cookie: "__Secure-skillplane.session=victim; skillplane.csrf=expected",
        },
      },
    );
    expect(() => enforceCookieCsrf(bearerWithVictimCookie, true, false)).toThrow(
      "could not be verified",
    );
  });

  it("never places raw invitation tokens into rate-limit storage keys", () => {
    const token = createOpaqueToken("spi");
    expect(rateLimitRouteKey(`/api/v1/invitations/${token}`)).toBe(
      "/api/v1/invitations/:token",
    );
    expect(rateLimitRouteKey(`/api/v1/invitations/${token}/accept`)).toBe(
      "/api/v1/invitations/:token/accept",
    );
    expect(rateLimitRouteKey(`/api/v1/invitations/${token}`)).not.toContain(token);
  });

  it("maps protected surfaces to operation-specific scopes", () => {
    expect(requiredAction("/api/v1/skills/search", "GET")).toBe("skills:read");
    expect(requiredAction("/api/v1/skills/example", "PATCH")).toBe("skills:write");
    expect(requiredAction("/api/v1/contexts/example", "POST")).toBe("contexts:write");
    expect(requiredAction("/api/v1/audit", "GET")).toBe("audit:read");
    expect(canPerform(servicePrincipal, "skills:read")).toBe(true);
    expect(canPerform(servicePrincipal, "skills:write")).toBe(false);
    expect(canPerform(servicePrincipal, "audit:read")).toBe(false);
    expect(() => authorize(servicePrincipal, "skills:write")).toThrow("required scope");
  });

  it("stores invitation recipients encrypted and lookup values as keyed hashes", async () => {
    const secret = "test-tenancy-secret-that-is-long-and-random";
    const email = "member@example.test";
    const ciphertext = await encryptEmail(secret, email);
    const lookup = await hashEmail(secret, email);
    expect(ciphertext).toMatch(/^v1\./u);
    expect(ciphertext).not.toContain(email);
    expect(lookup).toMatch(/^[a-f0-9]{64}$/u);
    expect(lookup).not.toContain(email);
    await expect(decryptEmail(secret, ciphertext)).resolves.toBe(email);
  });

  it("creates high-entropy invitation secrets whose hashes reveal no token", async () => {
    const invitation = createOpaqueToken("spi");
    expect(invitation).toMatch(/^spi_[A-Za-z0-9_-]{43}$/u);
    expect(await hashOpaqueToken(invitation)).not.toContain(invitation);
  });
});
