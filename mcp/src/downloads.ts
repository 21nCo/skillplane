import { stableJson } from "@skillplane/storage";
import {
  callerDeclarationSchema,
  McpToolError,
  type CallerDeclaration,
} from "@skillplane/mcp-schema";

export interface DownloadGrant {
  readonly version: 1;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly versionId: string;
  readonly path: string;
  readonly fileSha256: string;
  readonly bundleDigest: `sha256:${string}`;
  readonly credentialId: string;
  readonly requestId: string;
  readonly caller: CallerDeclaration;
  readonly expiresAt: number;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new McpToolError("AUTH_INVALID", "The download grant is invalid", {
      status: 401,
    });
  }
  try {
    const padded = value
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (encode(bytes) !== value) throw new Error("non-canonical");
    return bytes;
  } catch {
    throw new McpToolError("AUTH_INVALID", "The download grant is invalid", {
      status: 401,
    });
  }
}

async function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new McpToolError("INTERNAL_ERROR", "Download authorization is unavailable", {
      status: 500,
      retryable: true,
    });
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`skillplane-mcp-download\u0000${secret}`),
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

export async function signDownloadGrant(
  grant: DownloadGrant,
  secret: string,
): Promise<string> {
  const body = new TextEncoder().encode(stableJson(grant));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), body);
  return `${encode(body)}.${encode(new Uint8Array(signature))}`;
}

export async function verifyDownloadGrant(
  token: string,
  secret: string,
  now: Date,
): Promise<DownloadGrant> {
  const [bodyValue, signatureValue, extra] = token.split(".");
  if (!bodyValue || !signatureValue || extra) {
    throw new McpToolError("AUTH_INVALID", "The download grant is invalid", {
      status: 401,
    });
  }
  const body = decode(bodyValue);
  const signature = decode(signatureValue);
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      bufferSource(signature),
      bufferSource(body),
    ))
  ) {
    throw new McpToolError("AUTH_INVALID", "The download grant is invalid", {
      status: 401,
    });
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new McpToolError("AUTH_INVALID", "The download grant is invalid", {
      status: 401,
    });
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { workspaceId?: unknown }).workspaceId !== "string" ||
    typeof (value as { skillId?: unknown }).skillId !== "string" ||
    typeof (value as { versionId?: unknown }).versionId !== "string" ||
    typeof (value as { path?: unknown }).path !== "string" ||
    typeof (value as { fileSha256?: unknown }).fileSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test((value as { fileSha256: string }).fileSha256) ||
    typeof (value as { bundleDigest?: unknown }).bundleDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test((value as { bundleDigest: string }).bundleDigest) ||
    typeof (value as { credentialId?: unknown }).credentialId !== "string" ||
    typeof (value as { requestId?: unknown }).requestId !== "string" ||
    typeof (value as { expiresAt?: unknown }).expiresAt !== "number" ||
    !callerDeclarationSchema.safeParse((value as { caller?: unknown }).caller).success
  ) {
    throw new McpToolError("AUTH_INVALID", "The download grant is invalid", {
      status: 401,
    });
  }
  const grant = value as DownloadGrant;
  if (grant.expiresAt <= now.getTime()) {
    throw new McpToolError("AUTH_INVALID", "The download grant has expired", {
      status: 401,
    });
  }
  return grant;
}
