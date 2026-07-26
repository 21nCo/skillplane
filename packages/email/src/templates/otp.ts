import { emailShell, escapeHtml, type RenderedEmail } from "./shared.js";

export interface OtpTemplateInput {
  readonly code: string;
  readonly expiresInMinutes: number;
  readonly purpose: "verify-email" | "sign-in" | "sign-up" | "reset-password";
}

const purposeCopy: Record<OtpTemplateInput["purpose"], string> = {
  "verify-email": "verify your email",
  "sign-in": "sign in to Skillplane",
  "sign-up": "finish creating your Skillplane account",
  "reset-password": "continue your account recovery",
};

export function renderOtpEmail(input: OtpTemplateInput): RenderedEmail {
  if (!/^\d{6}$/.test(input.code)) {
    throw new Error("OTP code must contain exactly six digits");
  }
  if (!Number.isInteger(input.expiresInMinutes) || input.expiresInMinutes < 1) {
    throw new Error("OTP expiry must be a positive whole number of minutes");
  }
  const action = purposeCopy[input.purpose];
  const expiresInMinutes = String(input.expiresInMinutes);
  const subject = "Your Skillplane verification code";
  const text = [
    `Use ${input.code} to ${action}.`,
    "",
    `This code expires in ${expiresInMinutes} minutes and can be used once.`,
    "If you did not request this code, you can ignore this email.",
  ].join("\n");
  const code = escapeHtml(input.code);
  const content = `
<p style="margin:0 0 12px;color:#6d6d76;font-size:13px;font-weight:650;letter-spacing:.08em;text-transform:uppercase">Verification code</p>
<h1 style="margin:0 0 14px;font-size:25px;line-height:1.25">Continue to Skillplane</h1>
<p style="margin:0 0 24px;color:#50505a;font-size:15px;line-height:1.65">Use this code to ${escapeHtml(action)}.</p>
<div style="margin:0 0 24px;border:1px solid #d9d6ff;border-radius:10px;background:#f5f3ff;padding:18px;text-align:center;color:#3d327b;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:750;letter-spacing:.22em">${code}</div>
<p style="margin:0;color:#6d6d76;font-size:13px;line-height:1.65">The code expires in ${expiresInMinutes} minutes and can be used once. If you did not request it, no action is required.</p>`;
  return {
    subject,
    text,
    html: emailShell(`${input.code} is your Skillplane code.`, content),
  };
}
