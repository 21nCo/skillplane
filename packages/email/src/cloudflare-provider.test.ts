import { describe, expect, it } from "vitest";
import {
  CloudflareEmailProviderError,
  cloudflareEmailProvider,
  type CloudflareEmailMessage,
} from "./cloudflare-provider.js";

describe("CloudflareEmailProvider", () => {
  it("implements SendFn EmailProvider with a provider message ID", async () => {
    const messages: CloudflareEmailMessage[] = [];
    const provider = cloudflareEmailProvider({
      async send(message) {
        messages.push(message);
        return { messageId: "cf_msg_1" };
      },
    });
    await provider.initialize();
    const result = await provider.sendEmail({
      from: "Skillplane <no-reply@auth.skillplane.dev>",
      to: ["alice@example.test"],
      subject: "Verify",
      html: "<p>Use your code.</p>",
      text: "Use your code.",
    });

    expect(result).toMatchObject({
      success: true,
      messageId: "cf_msg_1",
      providerMessageId: "cf_msg_1",
    });
    expect(messages).toEqual([
      {
        from: { email: "no-reply@auth.skillplane.dev", name: "Skillplane" },
        to: "alice@example.test",
        subject: "Verify",
        html: "<p>Use your code.</p>",
        text: "Use your code.",
      },
    ]);
  });

  it("surfaces permanent binding rejection as a redacted typed failure", async () => {
    const provider = cloudflareEmailProvider({
      send() {
        return Promise.reject(
          Object.assign(new Error("domain and recipient details"), {
            code: "E_SENDER_DOMAIN_NOT_AVAILABLE",
          }),
        );
      },
    });

    const failure = await provider
      .sendEmail({
        from: "no-reply@auth.skillplane.dev",
        to: ["alice@example.test"],
        subject: "Verify",
        html: "<p>Use your code.</p>",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CloudflareEmailProviderError);
    expect(failure).toMatchObject({
      code: "EMAIL_DELIVERY_FAILED",
      provider: "cloudflare-email",
      providerCode: "E_SENDER_DOMAIN_NOT_AVAILABLE",
      retryable: false,
      message: "Email delivery failed",
    });
    expect(JSON.stringify(failure)).not.toContain("alice");
    expect(JSON.stringify(failure)).not.toContain("domain and recipient details");
  });

  it("maps attachments to Cloudflare's base64 builder contract", async () => {
    const messages: CloudflareEmailMessage[] = [];
    const provider = cloudflareEmailProvider({
      async send(message) {
        messages.push(message);
        return { messageId: "cf_msg_attachment" };
      },
    });
    await provider.sendEmail({
      from: "no-reply@auth.skillplane.dev",
      to: ["alice@example.test"],
      subject: "Attachment",
      html: "<p>Attached.</p>",
      attachments: [
        {
          filename: "notes.txt",
          content: "skillplane",
        },
      ],
    });
    expect(messages[0]?.attachments).toEqual([
      {
        content: Buffer.from("skillplane").toString("base64"),
        filename: "notes.txt",
        type: "application/octet-stream",
        disposition: "attachment",
      },
    ]);
  });
});
