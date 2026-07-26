import { stableJson } from "@skillplane/storage";
import { McpToolError } from "@skillplane/mcp-schema";

interface CursorEnvelope {
  readonly version: 1;
  readonly purpose: string;
  readonly filterHash: string;
  readonly boundary: Readonly<Record<string, unknown>>;
  readonly expiresAt: number;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) throw new Error("non-canonical");
    return bytes;
  } catch {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJson(value)),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

export class McpCursorCodec {
  constructor(
    private readonly secret: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (secret.length < 32) {
      throw new Error("MCP cursor secret must contain at least 32 characters");
    }
  }

  async encode(
    purpose: string,
    filters: unknown,
    boundary: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    const envelope: CursorEnvelope = {
      version: 1,
      purpose,
      filterHash: await hash(filters),
      boundary,
      expiresAt: this.now().getTime() + 15 * 60 * 1_000,
    };
    const body = new TextEncoder().encode(stableJson(envelope));
    const signature = await crypto.subtle.sign("HMAC", await key(this.secret), body);
    return `${encodeBase64Url(body)}.${encodeBase64Url(new Uint8Array(signature))}`;
  }

  async decode(
    cursor: string,
    purpose: string,
    filters: unknown,
  ): Promise<Readonly<Record<string, unknown>>> {
    const [bodyValue, signatureValue, extra] = cursor.split(".");
    if (!bodyValue || !signatureValue || extra) {
      throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
    }
    const body = decodeBase64Url(bodyValue);
    const signature = decodeBase64Url(signatureValue);
    const verified = await crypto.subtle.verify(
      "HMAC",
      await key(this.secret),
      bufferSource(signature),
      bufferSource(body),
    );
    if (!verified) {
      throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      (parsed as { purpose?: unknown }).purpose !== purpose ||
      typeof (parsed as { filterHash?: unknown }).filterHash !== "string" ||
      typeof (parsed as { expiresAt?: unknown }).expiresAt !== "number" ||
      !(parsed as { boundary?: unknown }).boundary ||
      typeof (parsed as { boundary?: unknown }).boundary !== "object" ||
      Array.isArray((parsed as { boundary?: unknown }).boundary)
    ) {
      throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
    }
    const envelope = parsed as CursorEnvelope;
    if (envelope.expiresAt <= this.now().getTime()) {
      throw new McpToolError("CURSOR_INVALID", "The cursor has expired");
    }
    if (envelope.filterHash !== (await hash(filters))) {
      throw new McpToolError(
        "CURSOR_FILTER_MISMATCH",
        "The cursor does not match the current filters",
      );
    }
    return envelope.boundary;
  }
}
