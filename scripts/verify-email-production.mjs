#!/usr/bin/env node

import { resolve } from "node:path";
import { Pool } from "pg";
import {
  isMain,
  pathExists,
  productionIssuer,
  productionStateDirectory,
  railwayDatabase,
  readJson,
  requireEnvironment,
  sha256,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";

const statePath = resolve(productionStateDirectory, "email-verification.json");

function recipient() {
  const value = requireEnvironment("SKILLPLANE_PRODUCTION_OTP_RECIPIENT")
    .trim()
    .toLowerCase();
  if (
    value.length > 254 ||
    /[\r\n<>]/u.test(value) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
  ) {
    throw new Error("SKILLPLANE_PRODUCTION_OTP_RECIPIENT is not a valid email");
  }
  return value;
}

function recipientHash(value) {
  return sha256(`skillplane-production-email-verification:${value}`);
}

function assertPrivateResponse(response, label) {
  if (!(response.headers.get("cache-control") ?? "").includes("no-store")) {
    throw new Error(`${label} is not protected by no-store`);
  }
  if (response.headers.get("access-control-allow-origin") === "*") {
    throw new Error(`${label} unexpectedly enables wildcard CORS`);
  }
}

async function responseBody(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function sendChallenge(email) {
  const turnstileToken = requireEnvironment("SKILLPLANE_PRODUCTION_TURNSTILE_TOKEN", {
    minimumLength: 20,
  });
  const response = await fetch(`${productionIssuer}/auth/otp/send`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      purpose: "sign-up",
      turnstileToken,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  assertPrivateResponse(response, "OTP send response");
  const body = await responseBody(response, "OTP send response");
  if (
    response.status !== 200 ||
    body.ok !== true ||
    body.data?.accepted !== true ||
    body.data?.expiresInSeconds !== 600
  ) {
    throw new Error(
      `Cloudflare Email Service did not accept the OTP request (${body.error?.code ?? response.status})`,
    );
  }
  const state = {
    ok: false,
    status: "awaiting-otp",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    recipientHash: recipientHash(email),
    provider: "cloudflare-email",
    sender: "no-reply@auth.skillplane.dev",
    requestId: body.requestId ?? body.meta?.requestId ?? null,
    deliveryAccepted: true,
  };
  await writeJsonAtomic(statePath, state, { mode: 0o600 });
  return {
    ...state,
    next: "Set SKILLPLANE_PRODUCTION_OTP_CODE to the received six-digit code and run pnpm verify:email:production again before expiry.",
  };
}

async function verifyChallenge(email, code) {
  if (!(await pathExists(statePath))) {
    throw new Error("No pending production OTP delivery verification exists");
  }
  const pending = await readJson(statePath);
  if (
    pending.status !== "awaiting-otp" ||
    pending.recipientHash !== recipientHash(email) ||
    Date.parse(pending.expiresAt) <= Date.now()
  ) {
    throw new Error(
      "The pending production OTP delivery verification is absent, expired, or belongs to another recipient",
    );
  }
  const response = await fetch(`${productionIssuer}/auth/otp/verify`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, code, purpose: "sign-up" }),
    signal: AbortSignal.timeout(15_000),
  });
  assertPrivateResponse(response, "OTP verify response");
  const body = await responseBody(response, "OTP verify response");
  if (response.status !== 200 || body.ok !== true) {
    throw new Error(
      `The delivered OTP could not be verified (${body.error?.code ?? response.status})`,
    );
  }
  const setCookie = response.headers.get("set-cookie") ?? "";
  for (const contract of [
    /__Secure-skillplane\.session=/iu,
    /HttpOnly/iu,
    /Secure/iu,
    /SameSite=Lax/iu,
  ]) {
    if (!contract.test(setCookie)) {
      throw new Error(
        "The verified OTP response did not issue the secure session cookie",
      );
    }
  }
  const verified = {
    ok: true,
    status: "verified",
    sentAt: pending.createdAt,
    verifiedAt: new Date().toISOString(),
    recipientHash: pending.recipientHash,
    provider: pending.provider,
    sender: pending.sender,
    sendRequestId: pending.requestId,
    verifyRequestId: body.requestId ?? body.meta?.requestId ?? null,
    deliveryAccepted: true,
    deliveredCodeVerified: true,
    sessionCookie: {
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  };
  await writeJsonAtomic(statePath, verified, { mode: 0o600 });
  return verified;
}

async function auditBrowserVerification(email) {
  const database = railwayDatabase();
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-production-email-verifier",
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const ssl = await pool.query(
      "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
    );
    if (ssl.rows[0]?.ssl !== true) {
      throw new Error("The email audit connection is not protected by SSL");
    }
    const result = await pool.query(
      `SELECT challenge.id,
              challenge.created_at,
              challenge.consumed_at,
              challenge.delivery_metadata,
              session.id IS NOT NULL AS active_session
         FROM authfn_otp_challenges challenge
         LEFT JOIN authfn_users account
           ON account.primary_email = challenge.email
         LEFT JOIN LATERAL (
           SELECT id
             FROM authfn_sessions
            WHERE user_id = account.id
              AND revoked_at IS NULL
              AND expires_at > now()
              AND methods @> '["email-otp"]'::jsonb
              AND created_at >= challenge.created_at
            ORDER BY created_at DESC
            LIMIT 1
         ) session ON true
        WHERE challenge.email = $1
          AND challenge.purpose = 'sign-up'
          AND challenge.created_at >= now() - interval '30 minutes'
        ORDER BY challenge.created_at DESC
        LIMIT 1`,
      [email],
    );
    const row = result.rows[0];
    const metadata = row?.delivery_metadata;
    if (
      !row ||
      !row.consumed_at ||
      row.active_session !== true ||
      !metadata ||
      metadata.provider !== "cloudflare-email" ||
      typeof metadata.providerMessageId !== "string" ||
      !metadata.providerMessageId
    ) {
      throw new Error(
        "No recently delivered, consumed Cloudflare Email Service OTP with an active session was found; complete sign-in in the production UI first",
      );
    }
    const verified = {
      ok: true,
      status: "verified",
      verificationMode: "production-browser-and-database-audit",
      sentAt: new Date(row.created_at).toISOString(),
      verifiedAt: new Date(row.consumed_at).toISOString(),
      auditedAt: new Date().toISOString(),
      recipientHash: recipientHash(email),
      provider: "cloudflare-email",
      providerMessageIdHash: sha256(metadata.providerMessageId),
      sender: "no-reply@auth.skillplane.dev",
      deliveryAccepted: true,
      deliveredCodeVerified: true,
      activeSessionVerified: true,
      databaseSsl: true,
      sessionCookie:
        "secure attributes are asserted by the production auth integration contract",
    };
    await writeJsonAtomic(statePath, verified, { mode: 0o600 });
    return verified;
  } finally {
    await pool.end();
  }
}

export async function verifyProductionEmail() {
  const email = recipient();
  const code = process.env.SKILLPLANE_PRODUCTION_OTP_CODE?.trim();
  if (code !== undefined && !/^\d{6}$/u.test(code)) {
    throw new Error("SKILLPLANE_PRODUCTION_OTP_CODE must contain exactly six digits");
  }
  if (code) return verifyChallenge(email, code);
  if (process.env.SKILLPLANE_PRODUCTION_TURNSTILE_TOKEN?.trim()) {
    return sendChallenge(email);
  }
  return auditBrowserVerification(email);
}

if (isMain(import.meta.url)) {
  const result = await verifyProductionEmail();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.ok !== true) process.exitCode = 2;
}
