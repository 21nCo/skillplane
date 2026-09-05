import { type AuthFnDeliveryProvider, type AuthFnDeliveryRequest } from "authfn";
import { createSendFn, type SendFnEdgeClient } from "sendfn/edge";
import {
  CloudflareEmailProviderError,
  type CloudflareEmailBinding,
  cloudflareEmailProvider,
} from "./cloudflare-provider.js";
import { renderOtpEmail } from "./templates/otp.js";

export interface CreateSkillplaneSendFnInput {
  readonly binding: CloudflareEmailBinding;
  readonly from: string;
  readonly environment: "local" | "preview" | "production";
  readonly signInUrl: string;
}

export interface SkillplaneSendFn {
  readonly client: SendFnEdgeClient;
  readonly delivery: AuthFnDeliveryProvider;
  close(): Promise<void>;
}

export class SkillplaneEmailDeliveryError extends Error {
  readonly code = "EMAIL_DELIVERY_FAILED";
  readonly provider = "cloudflare-email";
  readonly providerCode: string;
  readonly retryable: boolean;

  constructor(providerCode: string, retryable: boolean) {
    super("Email delivery failed");
    this.name = "SkillplaneEmailDeliveryError";
    this.providerCode = providerCode;
    this.retryable = retryable;
  }
}

function toDeliveryFailure(error: unknown): SkillplaneEmailDeliveryError {
  if (error instanceof CloudflareEmailProviderError) {
    return new SkillplaneEmailDeliveryError(error.providerCode, error.retryable);
  }
  return new SkillplaneEmailDeliveryError("E_UNKNOWN", true);
}

function createDelivery(
  client: SendFnEdgeClient,
  context: Pick<CreateSkillplaneSendFnInput, "environment" | "signInUrl">,
): AuthFnDeliveryProvider {
  return {
    async send(input: AuthFnDeliveryRequest) {
      const rendered = renderOtpEmail({
        code: input.code,
        expiresInMinutes: 10,
        purpose: input.purpose,
        environment: context.environment,
        signInUrl: context.signInUrl,
      });
      try {
        const transaction = await client.email({
          userId: "authfn",
          to: input.email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          metadata: {
            challengeId: input.challengeId,
            purpose: input.purpose,
          },
          tags: ["authentication", "otp"],
        });
        return {
          sent: true,
          metadata: {
            provider: transaction.provider,
            providerMessageId: transaction.providerMessageId,
            transactionId: transaction.id,
            sentAt: transaction.sentAt?.toISOString(),
          },
        };
      } catch (error) {
        throw toDeliveryFailure(error);
      }
    },
  };
}

export function createSkillplaneSendFn(
  input: CreateSkillplaneSendFnInput,
): SkillplaneSendFn {
  const provider = cloudflareEmailProvider(input.binding);
  const client = createSendFn({
    emailProvider: provider,
    email: {
      from: input.from,
    },
  });
  return {
    client,
    delivery: createDelivery(client, input),
    close: () => client.close(),
  };
}
