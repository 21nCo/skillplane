import { describe, expect, it } from "vitest";
import { renderInvitationEmail } from "./invitation.js";
import { renderOtpEmail } from "./otp.js";

describe("email templates", () => {
  it("renders a branded one-time code in text and sanitized HTML", () => {
    const rendered = renderOtpEmail({
      code: "123456",
      expiresInMinutes: 10,
      purpose: "sign-up",
    });
    expect(rendered.subject).toBe("Your Skillplane verification code");
    expect(rendered.text).toContain("123456");
    expect(rendered.html).toContain("123456");
    expect(rendered.html).not.toMatch(/<script|javascript:/i);
  });

  it("escapes invitation content and rejects unsafe links", () => {
    const rendered = renderInvitationEmail({
      inviterName: `<img src=x onerror="alert(1)">`,
      workspaceName: "<Engineering>",
      invitationUrl: "https://app.skillplane.dev/invitations/accept?token=opaque",
      expiresInHours: 48,
    });
    expect(rendered.html).toContain("&lt;Engineering&gt;");
    expect(rendered.html).not.toContain("<img");
    expect(() =>
      renderInvitationEmail({
        inviterName: "Ada",
        workspaceName: "Engineering",
        invitationUrl: "javascript:alert(1)",
        expiresInHours: 48,
      }),
    ).toThrow(/HTTPS/);
  });
});
