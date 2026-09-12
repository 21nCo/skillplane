import { AuthFnConfigError, AuthFnRateLimitedError, type AuthFnHooks } from "authfn";
import { AuthFnDeliveryFailedError } from "authfn/core/errors";
import type { OtpRateLimiter } from "./rate-limit.js";
import type { TurnstileVerifier } from "./turnstile.js";

export function createOtpPolicyHook(input: {
  readonly rateLimiter?: OtpRateLimiter;
  readonly turnstile?: TurnstileVerifier;
}): AuthFnHooks["beforeChallengeSend"] {
  return async (context, value) => {
    const request = context.request;
    const email = typeof value.email === "string" ? value.email : "";
    const metadata =
      value.metadata && typeof value.metadata === "object"
        ? (value.metadata as Record<string, unknown>)
        : {};
    const token =
      typeof metadata.turnstileToken === "string" ? metadata.turnstileToken : "";
    if (!request || !input.turnstile || !input.rateLimiter) {
      throw new AuthFnConfigError("Authentication is temporarily unavailable");
    }
    const incomingIp = request.headers.get("cf-connecting-ip")?.trim();
    const remoteIp = incomingIp?.length ? incomingIp : "unknown";
    const idempotencyKey = `turnstile_${crypto.randomUUID()}`;
    const verification = await input.turnstile.verify({
      token,
      remoteIp,
      idempotencyKey,
    });
    if (!verification.success) {
      if (verification.reason === "unavailable") {
        throw new AuthFnDeliveryFailedError(
          "Authentication is temporarily unavailable",
          { reason: verification.reason },
        );
      }
      throw new AuthFnRateLimitedError("Please wait before trying again", {
        reason: verification.reason,
      });
    }
    const rate = await input.rateLimiter.consume({ email, network: remoteIp });
    if (!rate.allowed) {
      throw new AuthFnRateLimitedError("Please wait before trying again", {
        retryAfterSeconds: rate.retryAfterSeconds,
        remaining: rate.remaining,
      });
    }
    const deliveryMetadata = { ...metadata };
    delete deliveryMetadata.turnstileToken;
    return {
      ...value,
      metadata: Object.keys(deliveryMetadata).length ? deliveryMetadata : undefined,
    };
  };
}
