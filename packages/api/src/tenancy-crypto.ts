const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacKey(secret: string, purpose: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${purpose}\u0000${secret}`),
  );
  return crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`invitation-email-encryption\u0000${secret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export function createOpaqueToken(prefix: "spi" | "sps"): string {
  return `${prefix}_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function hashOpaqueToken(token: string): Promise<string> {
  return digest(token);
}

export async function hashEmail(secret: string, email: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "invitation-email-lookup"),
    encoder.encode(email),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function encryptEmail(secret: string, email: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await aesKey(secret),
    encoder.encode(email),
  );
  return `v1.${toBase64Url(nonce)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptEmail(
  secret: string,
  ciphertext: string,
): Promise<string> {
  const [version, encodedNonce, encodedPayload] = ciphertext.split(".");
  if (version !== "v1" || !encodedNonce || !encodedPayload) {
    throw new Error("Invitation recipient data is not decryptable");
  }
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(encodedNonce) },
    await aesKey(secret),
    fromBase64Url(encodedPayload),
  );
  return decoder.decode(decrypted);
}
