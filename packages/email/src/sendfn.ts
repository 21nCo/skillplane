import { type AuthFnDeliveryProvider, type AuthFnDeliveryRequest } from "authfn";
import { createSendFn, type SendFnEdgeClient } from "sendfn/edge";
import {
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
