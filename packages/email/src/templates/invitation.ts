import { emailShell, escapeHtml, type RenderedEmail } from "./shared.js";

export interface InvitationTemplateInput {
  readonly inviterName: string;
  readonly workspaceName: string;
  readonly invitationUrl: string;
  readonly expiresInHours: number;
}

function validateInvitationUrl(value: string): string {
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password) {
    throw new Error(
      "Invitation URL must be HTTPS, or HTTP on a loopback development host",
    );
  }
  return url.toString();
}

export function renderInvitationEmail(input: InvitationTemplateInput): RenderedEmail {
  if (!Number.isInteger(input.expiresInHours) || input.expiresInHours < 1) {
    throw new Error("Invitation expiry must be a positive whole number of hours");
  }
  const invitationUrl = validateInvitationUrl(input.invitationUrl);
  const expiresInHours = String(input.expiresInHours);
  const subject = `Join ${input.workspaceName} on Skillplane`;
  const text = [
    `${input.inviterName} invited you to ${input.workspaceName} on Skillplane.`,
    "",
    invitationUrl,
    "",
    `This invitation expires in ${expiresInHours} hours.`,
  ].join("\n");
  const content = `
<p style="margin:0 0 12px;color:#6d6d76;font-size:13px;font-weight:650;letter-spacing:.08em;text-transform:uppercase">Workspace invitation</p>
<h1 style="margin:0 0 14px;font-size:25px;line-height:1.25">Join ${escapeHtml(input.workspaceName)}</h1>
<p style="margin:0 0 24px;color:#50505a;font-size:15px;line-height:1.65">${escapeHtml(input.inviterName)} invited you to collaborate on skills, contexts, and reusable agent knowledge.</p>
<a href="${escapeHtml(invitationUrl)}" style="display:inline-block;border-radius:8px;background:#5e50c7;padding:12px 18px;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none">Accept invitation</a>
<p style="margin:24px 0 0;color:#6d6d76;font-size:13px;line-height:1.65">This invitation expires in ${expiresInHours} hours.</p>`;
  return {
    subject,
    text,
    html: emailShell(`Join ${input.workspaceName} on Skillplane.`, content),
  };
}
