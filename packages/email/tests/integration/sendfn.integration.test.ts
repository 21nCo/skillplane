import { describe, expect, it } from "vitest";
import {
  createSkillplaneSendFn,
  type CloudflareEmailMessage,
} from "../../src/index.js";

describe("SendFn Cloudflare delivery", () => {
  it("delivers an AuthFn OTP through SendFn and returns provider evidence", async () => {
    const messages: CloudflareEmailMessage[] = [];
    const sendfn = createSkillplaneSendFn({
      from: "Skillplane <no-reply@auth.skillplane.dev>",
      binding: {
        async send(message) {
          messages.push(message);
          return { messageId: "cf_msg_1" };
        },
      },
    });
    try {
      const result = await sendfn.delivery.send({
        channel: "email",
        challengeId: "otp_1",
        purpose: "sign-in",
        email: "alice@example.test",
        code: "123456",
      });
      expect(result).toMatchObject({
        sent: true,
        metadata: {
          provider: "cloudflare-email",
          providerMessageId: "cf_msg_1",
        },
      });
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages[0])).toContain("123456");
    } finally {
      await sendfn.close();
    }
  });
});
