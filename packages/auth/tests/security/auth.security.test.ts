import { afterEach, describe, expect, it } from "vitest";
import {
  cookieHeader,
  createAuthTestEnvironment,
  type AuthTestEnvironment,
} from "../support/auth-test-environment.js";

let active: AuthTestEnvironment | undefined;

afterEach(async () => {
  await active?.close();
  active = undefined;
});

async function establishSession(environment: AuthTestEnvironment): Promise<string> {
  await environment.request("/auth/otp/send", {
    body: {
      email: environment.email,
      purpose: "sign-up",
      turnstileToken: "turnstile-pass",
    },
  });
  const verified = await environment.request("/auth/otp/verify", {
    body: {
      email: environment.email,
      purpose: "sign-up",
      code: "123456",
    },
  });
  expect(verified.status).toBe(200);
  return cookieHeader(verified);
}

describe("Skillplane authentication security", () => {
  it("requires a valid risk token before creating or delivering a challenge", async () => {
    active = await createAuthTestEnvironment();
    const denied = await active.request("/auth/otp/send", {
      body: {
        email: active.email,
        purpose: "sign-up",
        turnstileToken: "invalid-token",
      },
    });
    expect(denied.status).toBe(429);
    expect(await denied.json()).toMatchObject({
      ok: false,
      error: { code: "AUTH_RATE_LIMITED" },
    });
    expect(active.messages).toHaveLength(0);
    const challenges = await active.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM authfn_otp_challenges WHERE email = $1",
      [active.email],
    );
    expect(challenges.rows[0]?.count).toBe("0");
  });

  it("returns the same invalid-code envelope for known and unknown recipients", async () => {
    active = await createAuthTestEnvironment();
    await active.request("/auth/otp/send", {
      body: {
        email: active.email,
        purpose: "sign-up",
        turnstileToken: "turnstile-pass",
      },
    });
    const known = await active.request("/auth/otp/verify", {
      body: {
        email: active.email,
        purpose: "sign-up",
        code: "999999",
      },
    });
    const unknown = await active.request("/auth/otp/verify", {
      body: {
        email: `missing-${active.email}`,
        purpose: "sign-up",
        code: "999999",
      },
    });
    expect(known.status).toBe(400);
    expect(unknown.status).toBe(400);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("requires matching CSRF state for sign-out and API-key creation", async () => {
    active = await createAuthTestEnvironment();
    const cookies = await establishSession(active);

    const signOut = await active.request("/auth/sign-out", {
      headers: { cookie: cookies },
      body: {},
    });
    expect(signOut.status).toBe(403);
    expect(await signOut.json()).toMatchObject({
      ok: false,
      error: { code: "AUTHFN_CSRF_INVALID" },
    });

    const createKey = await active.request("/auth/api-keys", {
      headers: { cookie: cookies },
      body: { name: "missing-csrf", scopes: ["skills:read"] },
    });
    expect(createKey.status).toBe(403);
    expect(await createKey.json()).toMatchObject({
      ok: false,
      error: { code: "AUTHFN_CSRF_INVALID" },
    });
  });

  it("rate-limits before a second delivery without echoing the recipient", async () => {
    active = await createAuthTestEnvironment({
      recipientLimit: 1,
      networkLimit: 10,
    });
    const first = await active.request("/auth/otp/send", {
      body: {
        email: active.email,
        purpose: "sign-up",
        turnstileToken: "turnstile-pass",
      },
    });
    expect(first.status).toBe(200);
    const limited = await active.request("/auth/otp/send", {
      body: {
        email: active.email,
        purpose: "sign-up",
        turnstileToken: "turnstile-pass",
      },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    const serialized = JSON.stringify(await limited.json());
    expect(serialized).toContain("AUTH_RATE_LIMITED");
    expect(serialized).not.toContain(active.email);
    expect(active.messages).toHaveLength(1);
  });
});
