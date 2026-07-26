import { Buffer } from "node:buffer";
import type { EmailProvider } from "sendfn";

type SendEmailRequest = Parameters<EmailProvider["sendEmail"]>[0];
type SendEmailResponse = Awaited<ReturnType<EmailProvider["sendEmail"]>>;

export interface CloudflareEmailAddress {
  readonly email: string;
  readonly name?: string;
}

export interface CloudflareEmailAttachment {
  readonly content: string;
  readonly filename: string;
  readonly type: string;
  readonly disposition: "attachment";
}

export interface CloudflareEmailMessage {
  readonly to: string | readonly string[];
  readonly from: string | CloudflareEmailAddress;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
  readonly replyTo?: string;
  readonly attachments?: readonly CloudflareEmailAttachment[];
}

export interface CloudflareEmailSendResult {
  readonly messageId: string;
}

export interface CloudflareEmailBinding {
  send(message: CloudflareEmailMessage): Promise<CloudflareEmailSendResult>;
}

export class CloudflareEmailProviderError extends Error {
  readonly code = "EMAIL_DELIVERY_FAILED";
  readonly provider = "cloudflare-email";
  readonly providerCode: string;
  readonly retryable: boolean;

  constructor(providerCode: string, retryable: boolean) {
    super("Email delivery failed");
    this.name = "CloudflareEmailProviderError";
    this.providerCode = providerCode;
    this.retryable = retryable;
  }
}

const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const MAX_ATTACHMENTS = 32;
const RETRYABLE_PROVIDER_CODES = new Set([
  "E_INTERNAL_SERVER_ERROR",
  "E_RATE_LIMIT_EXCEEDED",
  "E_RATE_LIMITED",
  "E_SERVICE_UNAVAILABLE",
  "E_TEMPORARY_FAILURE",
  "E_UPSTREAM",
]);

function isEmail(value: string): boolean {
  return (
    value.length <= 254 &&
    !/[\r\n<>]/.test(value) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function parseSender(value: string): string | CloudflareEmailAddress {
  const trimmed = value.trim();
  if (isEmail(trimmed)) return trimmed;
  const match = /^([^<>\r\n]+)\s*<([^<>\r\n]+)>$/.exec(trimmed);
  const name = match?.[1]?.trim().replace(/^"|"$/g, "");
  const email = match?.[2]?.trim();
  if (!name || !email || !isEmail(email)) {
    throw new CloudflareEmailProviderError("E_INVALID_SENDER", false);
  }
  return { email, name };
}

function attachmentContent(
  content: Buffer | string,
  encoding: string | undefined,
): string {
  if (typeof content !== "string") return content.toString("base64");
  if (encoding?.toLowerCase() === "base64") return content;
  return Buffer.from(
    content,
    (encoding as BufferEncoding | undefined) ?? "utf8",
  ).toString("base64");
}

function mapAttachments(
  attachments: SendEmailRequest["attachments"],
): readonly CloudflareEmailAttachment[] | undefined {
  return attachments?.map((attachment) => ({
    filename: attachment.filename,
    content: attachmentContent(attachment.content, attachment.encoding),
    type: attachment.contentType ?? "application/octet-stream",
    disposition: "attachment",
  }));
}

function requestBytes(
  request: SendEmailRequest,
  attachments: readonly CloudflareEmailAttachment[] | undefined,
): number {
  return (
    Buffer.byteLength(request.subject) +
    Buffer.byteLength(request.html) +
    Buffer.byteLength(request.text ?? "") +
    (attachments?.reduce(
      (total, attachment) =>
        total +
        Buffer.byteLength(attachment.content) +
        Buffer.byteLength(attachment.filename),
      0,
    ) ?? 0)
  );
}

function providerCode(error: unknown): string {
  if (!error || typeof error !== "object") return "E_UNKNOWN";
  const candidate = error as { readonly code?: unknown };
  return typeof candidate.code === "string" && /^[A-Z0-9_]{2,80}$/.test(candidate.code)
    ? candidate.code
    : "E_UNKNOWN";
}

export class CloudflareEmailProvider implements EmailProvider {
  readonly name = "cloudflare-email";
  readonly capabilities = {
    supportsTemplates: false,
    supportsAttachments: true,
    supportsBulkSend: false,
    supportsScheduling: false,
    maxRecipientsPerEmail: MAX_RECIPIENTS,
    maxAttachmentSize: MAX_MESSAGE_BYTES,
  } as const;

  readonly #binding: CloudflareEmailBinding;
  #initialized = false;

  constructor(binding: CloudflareEmailBinding) {
    this.#binding = binding;
  }

  initialize(): Promise<void> {
    if (typeof this.#binding.send !== "function") {
      throw new CloudflareEmailProviderError("E_BINDING_UNAVAILABLE", true);
    }
    this.#initialized = true;
    return Promise.resolve();
  }

  async sendEmail(request: SendEmailRequest): Promise<SendEmailResponse> {
    if (!this.#initialized) await this.initialize();
    const recipients = [...request.to, ...(request.cc ?? []), ...(request.bcc ?? [])];
    if (
      request.to.length === 0 ||
      recipients.length > MAX_RECIPIENTS ||
      recipients.some((recipient) => !this.validateEmail(recipient)) ||
      /[\r\n]/.test(request.subject)
    ) {
      throw new CloudflareEmailProviderError("E_INVALID_MESSAGE", false);
    }
    const attachments = mapAttachments(request.attachments);
    if ((attachments?.length ?? 0) > MAX_ATTACHMENTS) {
      throw new CloudflareEmailProviderError("E_TOO_MANY_ATTACHMENTS", false);
    }
    if (requestBytes(request, attachments) > MAX_MESSAGE_BYTES) {
      throw new CloudflareEmailProviderError("E_MESSAGE_TOO_BIG", false);
    }

    try {
      const primaryRecipients = request.to.length === 1 ? request.to[0] : request.to;
      if (!primaryRecipients) {
        throw new CloudflareEmailProviderError("E_INVALID_MESSAGE", false);
      }
      const result = await this.#binding.send({
        to: primaryRecipients,
        from: parseSender(request.from),
        ...(request.cc?.length ? { cc: request.cc } : {}),
        ...(request.bcc?.length ? { bcc: request.bcc } : {}),
        subject: request.subject,
        ...(request.html ? { html: request.html } : {}),
        ...(request.text ? { text: request.text } : {}),
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
        ...(attachments?.length ? { attachments } : {}),
      });
      if (!result.messageId.trim()) {
        throw new CloudflareEmailProviderError("E_MESSAGE_ID_MISSING", true);
      }
      return {
        success: true,
        messageId: result.messageId,
        providerMessageId: result.messageId,
        timestamp: new Date(),
      };
    } catch (error) {
      if (error instanceof CloudflareEmailProviderError) throw error;
      const code = providerCode(error);
      throw new CloudflareEmailProviderError(code, RETRYABLE_PROVIDER_CODES.has(code));
    }
  }

  sendBulkEmail(requests: SendEmailRequest[]): Promise<SendEmailResponse[]> {
    return Promise.all(requests.map((request) => this.sendEmail(request)));
  }

  validateEmail(email: string): boolean {
    return isEmail(email.trim());
  }

  isHealthy(): Promise<boolean> {
    return Promise.resolve(
      this.#initialized && typeof this.#binding.send === "function",
    );
  }

  close(): Promise<void> {
    this.#initialized = false;
    return Promise.resolve();
  }
}

export function cloudflareEmailProvider(
  binding: CloudflareEmailBinding,
): CloudflareEmailProvider {
  return new CloudflareEmailProvider(binding);
}
