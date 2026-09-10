import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { normalizeOAuthConfig, type OAuthSecurityEvent } from "./config.js";
import { exchangeRefreshToken } from "./refresh.js";
import { keyedHash } from "./tokens.js";
import { redactAuditMetadata } from "../../observability/src/redaction.js";

vi.mock("@skillplane/db", () => ({
  consumeRateLimit: async () => ({ allowed: true }),
}));
vi.mock("./audit.js", () => ({
  oauthRequestId: () => "oauth:test-request",
  writeOAuthAudit: vi.fn(async () => undefined),
}));
const now = new Date("2026-09-10T10:00:00Z");
const pepper = "test-only-diagnostic-pepper-with-32-characters";
const secret = "spr_private-refresh-credential";
function harness(overrides: Record<string, unknown> | null = {}, failCommit = false) {
  const events: OAuthSecurityEvent[] = [];
  const row =
    overrides === null
      ? undefined
      : {
          id: "ort_generation",
          parent_id: "ort_parent",
          family_id: "otf_family",
          user_id: "user_test",
          client_id: "client_test",
          resource: "https://mcp.example.test/mcp",
          scopes: ["skills:read"],
          expires_at: new Date(now.getTime() + 60_000),
          consumed_at: null,
          revoked_at: null,
          ...overrides,
        };
  const query = vi.fn(async (sql: string) => {
    if (failCommit && sql === "COMMIT") throw new Error("database password=private");
    return { rows: sql.includes("SELECT id, parent_id") && row ? [row] : [] };
  });
  const release = vi.fn();
  const runtime = normalizeOAuthConfig({
    pool: { connect: async () => ({ query, release }) } as unknown as Pool,
    issuer: "https://app.example.test",
    resource: "https://mcp.example.test/mcp",
    tokenPepper: pepper,
    now: () => now,
    emit: (event) => {
      events.push(event);
    },
  });
  const input = {
    refreshToken: secret,
    clientId: "client_test",
    request: new Request("https://app.example.test/auth/oauth/token", {
      headers: {
        "user-agent": "codex-mcp-client/0.153.4",
        "cf-ray": "0123456789abcdef-HYD",
        "cf-connecting-ip": "192.0.2.1",
        authorization: "Bearer never-log-me",
      },
    }),
  };
  return { runtime, input, events, query, release };
}

describe("refresh completion diagnostics", () => {
  it.each([
    [null, "unknown_grant"],
    [{ revoked_at: now }, "revoked_grant"],
    [{ expires_at: now }, "expired_grant"],
    [{ client_id: "another-client" }, "client_mismatch"],
    [{ resource: "https://other.example.test/mcp" }, "resource_mismatch"],
  ])("records rejection outside rollback: %s", async (row, reason) => {
    const h = harness(row);
    await expect(exchangeRefreshToken(h.runtime, h.input)).rejects.toMatchObject({
      code: "invalid_grant",
    });
    expect(h.query).toHaveBeenCalledWith("ROLLBACK");
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.events.at(-1)?.metadata).toMatchObject({
      reason,
      transactionCommitted: false,
    });
    expect(h.events.at(-1)?.requestId).toBe("oauth:test-request");
  });

  it("links committed rotation to the replacement without emitting secrets or lookup hashes", async () => {
    const h = harness();
    const result = await exchangeRefreshToken(h.runtime, h.input);
    const event = h.events.at(-1);
    if (!event) throw new Error("Completion event missing");
    expect(event.metadata).toMatchObject({
      reason: "rotated",
      transactionCommitted: true,
      familyId: "otf_family",
      grantId: "ort_generation",
      parentGrantId: "ort_parent",
      cfRay: "0123456789abcdef-HYD",
      clientSoftware: "codex-mcp-client/0.153.4",
    });
    const next = harness({ revoked_at: now });
    await expect(
      exchangeRefreshToken(next.runtime, {
        ...next.input,
        refreshToken: result.refresh_token,
      }),
    ).rejects.toThrow();
    expect(next.events[0]?.metadata?.grantFingerprint).toBe(
      event.metadata?.replacementFingerprint,
    );
    const text = JSON.stringify(h.events);
    for (const value of [
      secret,
      result.refresh_token,
      result.access_token,
      pepper,
      "192.0.2.1",
      "never-log-me",
      keyedHash(secret, pepper),
    ])
      expect(text).not.toContain(value);
    expect(redactAuditMetadata(event.metadata).removedFieldCount).toBe(0);
  });

  it("rejects invalid scopes and fingerprints arbitrary agent headers", async () => {
    const h = harness();
    h.input.request.headers.set("user-agent", "Bearer confidential-header-value");
    await expect(
      exchangeRefreshToken(h.runtime, { ...h.input, scope: "skills:write" }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    expect(h.events[0]?.metadata).toMatchObject({
      reason: "invalid_scope",
      transactionCommitted: false,
    });
    expect(h.events[0]?.metadata?.clientSoftware).toBeUndefined();
    expect(JSON.stringify(h.events)).not.toContain("confidential-header-value");
  });

  it("identifies replay and confirms family revocation committed", async () => {
    const h = harness({ consumed_at: new Date(now.getTime() - 285_000) });
    await expect(exchangeRefreshToken(h.runtime, h.input)).rejects.toMatchObject({
      code: "invalid_grant",
    });
    expect(h.events[0]?.metadata).toMatchObject({
      reason: "reuse_detected",
      transactionCommitted: true,
      consumedAt: "2026-09-10T09:55:15.000Z",
    });
  });

  it("does not claim a successful rotation if commit fails", async () => {
    const h = harness({}, true);
    await expect(exchangeRefreshToken(h.runtime, h.input)).rejects.toThrow("database");
    expect(h.events[0]).toMatchObject({
      outcome: "error",
      metadata: { transactionCommitted: false },
    });
    expect(JSON.stringify(h.events)).not.toContain("password");
  });

  it("does not let diagnostic delivery failure replace success or the original rejection", async () => {
    const h = harness();
    vi.spyOn(h.runtime, "emit").mockRejectedValue(new Error("telemetry unavailable"));
    await expect(exchangeRefreshToken(h.runtime, h.input)).resolves.toHaveProperty(
      "refresh_token",
    );
    const bad = harness(null);
    vi.spyOn(bad.runtime, "emit").mockRejectedValue(new Error("telemetry unavailable"));
    await expect(exchangeRefreshToken(bad.runtime, bad.input)).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });
});
