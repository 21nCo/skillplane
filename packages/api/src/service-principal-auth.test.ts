import { AuthFnApiKeyRevokedError } from "@authfn/core";
import { describe, expect, it, vi } from "vitest";
import { authenticateServicePrincipalRequest } from "./service-principal-auth.js";

function request(scheme = "Bearer"): Request {
  return new Request("https://skillplane.test/api/v1/skills/search", {
    headers: { authorization: `${scheme} spk_example` },
  });
}

const validIdentity = {
  id: "key_review",
  type: "api-key",
  actorType: "api-key",
  actorId: "key_review",
  metadata: {
    kind: "skillplane_service_principal",
    servicePrincipalId: "service-principal:review",
    workspaceId: "workspace:review",
    credentialVersion: 1,
  },
};

const validRow = {
  id: "service-principal:review",
  workspace_id: "workspace:review",
  name: "Review agent",
  role: "viewer",
  scopes: ["skills:read"],
  delegated_user_id: null,
  expires_at: null,
  revoked_at: null,
  credential_version: 1,
  authfn_api_key_id: "key_review",
};

describe("service-principal authentication", () => {
  it("propagates infrastructure failures from AuthFn", async () => {
    const failure = new Error("database unavailable");
    const services = {
      auth: { apiKeys: { authenticate: vi.fn().mockRejectedValue(failure) } },
      database: { pool: { query: vi.fn() } },
    };

    await expect(
      authenticateServicePrincipalRequest(request(), services as never),
    ).rejects.toBe(failure);
  });

  it("maps a revoked AuthFn key to invalid authentication", async () => {
    const services = {
      auth: {
        apiKeys: {
          authenticate: vi.fn().mockRejectedValue(new AuthFnApiKeyRevokedError()),
        },
      },
      database: { pool: { query: vi.fn() } },
    };

    await expect(
      authenticateServicePrincipalRequest(request(), services as never),
    ).rejects.toMatchObject({ name: "InvalidAuthenticationError" });
  });

  it.each([
    [
      "a non-API-key identity",
      { ...validIdentity, type: "session", actorType: "user" },
      validRow,
    ],
    ["a missing service-principal row", validIdentity, null],
    [
      "a locally revoked service principal",
      validIdentity,
      { ...validRow, revoked_at: new Date() },
    ],
    [
      "a mismatched AuthFn key mapping",
      validIdentity,
      { ...validRow, authfn_api_key_id: "key_other" },
    ],
    [
      "mismatched credential metadata",
      {
        ...validIdentity,
        metadata: { ...validIdentity.metadata, workspaceId: "workspace:other" },
      },
      validRow,
    ],
    [
      "a mismatched credential version",
      {
        ...validIdentity,
        metadata: { ...validIdentity.metadata, credentialVersion: 2 },
      },
      validRow,
    ],
    ["an owner-role service principal", validIdentity, { ...validRow, role: "owner" }],
    [
      "an invalid service-principal scope",
      validIdentity,
      { ...validRow, scopes: ["skills:read", "workspace:delete"] },
    ],
  ])("rejects %s", async (_case, identity, row) => {
    const services = {
      auth: { apiKeys: { authenticate: vi.fn().mockResolvedValue(identity) } },
      database: {
        pool: {
          query: vi.fn().mockResolvedValue({ rows: row ? [row] : [] }),
        },
      },
    };

    await expect(
      authenticateServicePrincipalRequest(request(), services as never),
    ).rejects.toMatchObject({ name: "InvalidAuthenticationError" });
  });

  it("accepts case-insensitive Bearer schemes and throttles usage writes", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "service-principal:review",
            workspace_id: "workspace:review",
            name: "Review agent",
            role: "viewer",
            scopes: ["skills:read"],
            delegated_user_id: null,
            expires_at: null,
            revoked_at: null,
            credential_version: 1,
            authfn_api_key_id: "key_review",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const services = {
      auth: {
        apiKeys: {
          authenticate: vi.fn().mockResolvedValue(validIdentity),
        },
      },
      database: { pool: { query } },
    };

    await expect(
      authenticateServicePrincipalRequest(request("bEaReR"), services as never),
    ).resolves.toMatchObject({
      credentialId: "key_review",
      principal: { servicePrincipalId: "service-principal:review" },
    });
    expect(query.mock.calls[1]?.[0]).toContain(
      "last_used_at < now() - interval '1 minute'",
    );
  });
});
