import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresOtpRateLimiter, type OtpRateLimiter } from "../../src/index.js";
import {
  cookieHeader,
  createAuthTestEnvironment,
  csrfFromCookieHeader,
  type AuthTestEnvironment,
} from "../support/auth-test-environment.js";

let active: AuthTestEnvironment | undefined;

afterEach(async () => {
  await active?.close();
  active = undefined;
});

async function sendOtp(environment: AuthTestEnvironment): Promise<Response> {
  return environment.request("/auth/otp/send", {
    body: {
      email: environment.email,
      purpose: "sign-up",
      turnstileToken: "turnstile-pass",
    },
  });
}

describe("Skillplane email OTP integration", () => {
  it("returns an unowned service key when created-event emission fails", async () => {
    active = await createAuthTestEnvironment({
      emit: () => Promise.reject(new Error("observability unavailable")),
    });

    let keyId: string | undefined;
    try {
      const created = await active.server.apiKeys.create({
        ownerUserId: "user:issuing-administrator",
        name: "Skillplane agent: review",
        scopes: ["skills:read"],
        metadata: { kind: "skillplane_service_principal" },
        expiresAt: null,
        requestId: "req_emit_failure",
      });
      keyId = created.keyId;

      expect(created.secret).toMatch(/^spk_/u);
      const stored = await active.pool.query<{ user_id: string | null }>(
        "SELECT user_id FROM authfn_api_keys WHERE id = $1",
        [created.keyId],
      );
      expect(stored.rows[0]?.user_id).toBeNull();
    } finally {
      if (keyId) {
        await active.pool.query("DELETE FROM authfn_api_keys WHERE id = $1", [keyId]);
      }
    }
  });

  it("delivers through SendFn, stores only a hash, and persists a secure session", async () => {
    active = await createAuthTestEnvironment();
    const sent = await sendOtp(active);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({
      ok: true,
      data: { accepted: true, expiresInSeconds: 600 },
      requestId: "req_auth_test",
    });
    expect(active.messages).toHaveLength(1);
    expect(JSON.stringify(active.messages[0])).toContain("123456");

    const challenge = await active.pool.query<{
      code_hash: string;
      delivery_metadata: Record<string, unknown>;
    }>(
      `SELECT code_hash, delivery_metadata
         FROM authfn_otp_challenges
        WHERE email = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [active.email],
    );
    expect(challenge.rows[0]?.code_hash).toBe(
      createHash("sha256").update("123456").digest("hex"),
    );
    expect(JSON.stringify(challenge.rows[0])).not.toContain('"123456"');
    expect(challenge.rows[0]?.delivery_metadata).toMatchObject({
      provider: "cloudflare-email",
      providerMessageId: "cf_test_1",
    });

    const verified = await active.request("/auth/otp/verify", {
      body: {
        email: active.email,
        purpose: "sign-up",
        code: "123456",
      },
    });
    expect(verified.status).toBe(200);
    const cookies = cookieHeader(verified);
    expect(verified.headers.get("set-cookie")).toContain(
      "__Secure-skillplane.session=",
    );
    expect(verified.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(verified.headers.get("set-cookie")).toMatch(/Secure/i);
    expect(verified.headers.get("set-cookie")).toMatch(/SameSite=Lax/i);

    const session = await active.request("/auth/session", {
      method: "GET",
      headers: { cookie: cookies },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      ok: true,
      data: {
        session: {
          actorType: "user",
          subject: { email: active.email },
          methods: ["email-otp"],
        },
      },
    });
    const persisted = await active.pool.query<{ session_count: string }>(
      `SELECT count(*)::text AS session_count
         FROM authfn_sessions s
         JOIN authfn_users u ON u.id = s.user_id
        WHERE u.primary_email = $1 AND s.revoked_at IS NULL`,
      [active.email],
    );
    expect(persisted.rows[0]?.session_count).toBe("1");

    const csrf = csrfFromCookieHeader(cookies);
    const createKey = await active.request("/auth/api-keys", {
      headers: { cookie: cookies, "x-authfn-csrf": csrf },
      body: { name: "integration", scopes: ["skills:read"] },
    });
    expect(createKey.status).toBe(201);
    const createdKey = await createKey.json();
    expect(createdKey).toMatchObject({
      ok: true,
      data: { secretReturnedOnce: true },
    });
    expect(createdKey.data.secret).toMatch(/^spk_/);
    const storedKey = await active.pool.query<{ secret_hash: string }>(
      `SELECT secret_hash
         FROM authfn_api_keys k
         JOIN authfn_users u ON u.id = k.user_id
        WHERE u.primary_email = $1`,
      [active.email],
    );
    expect(storedKey.rows[0]?.secret_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedKey.rows[0]?.secret_hash).not.toBe(createdKey.data.secret);
  });

  it("keeps OTP-send responses identical before and after account creation", async () => {
    active = await createAuthTestEnvironment();
    const unknown = await sendOtp(active);
    const unknownBody = await unknown.json();
    await active.request("/auth/otp/verify", {
      body: {
        email: active.email,
        purpose: "sign-up",
        code: "123456",
      },
    });
    const known = await sendOtp(active);
    expect(await known.json()).toEqual(unknownBody);
  });

  it("expires challenges and returns a safe, non-enumerating error", async () => {
    let now = new Date("2026-07-26T00:00:00.000Z");
    active = await createAuthTestEnvironment({ now: () => now });
    await sendOtp(active);
    now = new Date("2026-07-26T00:10:01.000Z");
    const expired = await active.request("/auth/otp/verify", {
      body: {
        email: active.email,
        purpose: "sign-up",
        code: "123456",
      },
    });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({
      ok: false,
      error: {
        code: "AUTH_OTP_EXPIRED",
        message: "The verification code has expired",
        retryable: false,
      },
      requestId: "req_auth_test",
    });
  });

  it("enforces recipient limits atomically under concurrency", async () => {
    active = await createAuthTestEnvironment();
    const limiter: OtpRateLimiter = createPostgresOtpRateLimiter({
      pool: active.pool,
      pepper: "auth-test-concurrency-pepper-32-characters",
      recipientLimit: 5,
      networkLimit: 20,
      windowSeconds: 900,
    });
    const unique = randomUUID();
    const decisions = await Promise.all(
      Array.from({ length: 12 }, () =>
        limiter.consume({
          email: `rate-${unique}@auth.skillplane.test`,
          network: `network-${unique}`,
          now: new Date("2026-07-26T00:00:00.000Z"),
        }),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(7);
  });

  it("emits only the allowlisted event projection", async () => {
    active = await createAuthTestEnvironment();
    await sendOtp(active);
    await active.request("/auth/otp/verify", {
      body: {
        email: active.email,
        purpose: "sign-up",
        code: "123456",
      },
    });
    const serialized = JSON.stringify(active.events);
    expect(serialized).toContain("authfn.otp.sent");
    expect(serialized).not.toContain(active.email);
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("metadata");
  });
});
