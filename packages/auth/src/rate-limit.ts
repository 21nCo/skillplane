import { createHmac } from "node:crypto";
import { consumeRateLimit } from "@skillplane/db";
import type { Pool } from "pg";

export interface OtpRateLimitInput {
  readonly email: string;
  readonly network: string;
  readonly now?: Date;
}

export interface OtpRateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface OtpRateLimiter {
  consume(input: OtpRateLimitInput): Promise<OtpRateLimitDecision>;
}

export interface PostgresOtpRateLimiterOptions {
  readonly pool: Pool;
  readonly pepper: string;
  readonly recipientLimit?: number;
  readonly networkLimit?: number;
  readonly windowSeconds?: number;
}

function privateKey(pepper: string, kind: string, value: string): string {
  return createHmac("sha256", pepper).update(`${kind}\0${value}`).digest("hex");
}

export function createPostgresOtpRateLimiter(
  options: PostgresOtpRateLimiterOptions,
): OtpRateLimiter {
  if (options.pepper.length < 32) {
    throw new Error("OTP rate-limit pepper must contain at least 32 characters");
  }
  const windowSeconds = options.windowSeconds ?? 15 * 60;
  const recipientLimit = options.recipientLimit ?? 5;
  const networkLimit = options.networkLimit ?? 20;
  return {
    async consume(input) {
      const [recipient, network] = await Promise.all([
        consumeRateLimit(
          options.pool,
          privateKey(options.pepper, "otp-recipient", input.email),
          recipientLimit,
          windowSeconds,
          input.now,
        ),
        consumeRateLimit(
          options.pool,
          privateKey(options.pepper, "otp-network", input.network),
          networkLimit,
          windowSeconds,
          input.now,
        ),
      ]);
      return {
        allowed: recipient.allowed && network.allowed,
        remaining: Math.min(recipient.remaining, network.remaining),
        retryAfterSeconds: Math.max(
          recipient.retryAfterSeconds,
          network.retryAfterSeconds,
        ),
      };
    },
  };
}
