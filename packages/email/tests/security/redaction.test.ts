import { describe, expect, it } from "vitest";
import {
  CloudflareEmailProviderError,
  cloudflareEmailProvider,
} from "../../src/index.js";

describe("auth email redaction", () => {
  it("does not retain provider messages, recipients, or bodies in typed failures", async () => {
    const provider = cloudflareEmailProvider({
      send() {
        return Promise.reject(
          Object.assign(new Error("alice@example.test body 123456"), {
            code: "E_SENDER_NOT_VERIFIED",
          }),
        );
      },
    });
    const error = await provider
      .sendEmail({
        from: "no-reply@auth.skillplane.dev",
        to: ["alice@example.test"],
        subject: "Code 123456",
        html: "<p>123456</p>",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CloudflareEmailProviderError);
    expect(JSON.stringify(error)).not.toMatch(/alice|123456|body/i);
  });
});
