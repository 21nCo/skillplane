import { describe, expect, it } from "vitest";
import { renderInvitationEmail } from "./invitation.js";
import { renderOtpEmail } from "./otp.js";

describe("email templates", () => {
  it("renders a branded one-time code in text and sanitized HTML", () => {
    const rendered = renderOtpEmail({
      code: "123456",
      expiresInMinutes: 10,
      purpose: "sign-up",
      environment: "preview",
      signInUrl: "https://app-dev.skillplane.dev",
    });
    expect(rendered.subject).toBe("[Skillplane Development] Verification code");
    expect(rendered.text).toContain("123456");
    expect(rendered.text).toContain("Environment: Development");
    expect(rendered.text).toContain("Sign-in site: https://app-dev.skillplane.dev");
    expect(rendered.html).toContain("123456");
    expect(rendered.html).toContain("app-dev.skillplane.dev");
    expect(rendered.html).not.toMatch(/<script|javascript:/i);
  });

  it("keeps production subject stable while identifying the canonical site", () => {
    const rendered = renderOtpEmail({
      code: "123456",
      expiresInMinutes: 10,
      purpose: "sign-in",
      environment: "production",
      signInUrl: "https://app.skillplane.dev",
    });
    expect(rendered.subject).toBe("Your Skillplane verification code");
    expect(rendered.text).toContain("Environment: Production");
    expect(rendered.text).toContain("Sign-in site: https://app.skillplane.dev");
  });

  it("labels local codes and rejects credential-bearing sign-in URLs", () => {
    const rendered = renderOtpEmail({
      code: "123456",
      expiresInMinutes: 10,
      purpose: "sign-in",
      environment: "local",
      signInUrl: "http://localhost:5700",
    });
    expect(rendered.subject).toBe("[Skillplane Local] Verification code");
    expect(rendered.text).toContain("Environment: Local");
    expect(rendered.text).toContain("Sign-in site: http://localhost:5700");
    expect(() =>
      renderOtpEmail({
        code: "123456",
        expiresInMinutes: 10,
        purpose: "sign-in",
        environment: "preview",
        signInUrl: "https://user:password@app-dev.skillplane.dev",
      }),
    ).toThrow(/HTTPS or loopback HTTP/u);
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
