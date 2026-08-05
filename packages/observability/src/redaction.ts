const MAX_DEPTH = 8;
const MAX_KEYS = 200;
const MAX_ARRAY_ITEMS = 200;
const MAX_STRING_LENGTH = 4_096;

const PROHIBITED_KEYS = new Set([
  "authorization",
  "body",
  "cookie",
  "email",
  "instructions",
  "otp",
  "password",
  "prompt",
  "secret",
  "skillbody",
  "skillcontent",
  "token",
]);

const EMAIL_VALUE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const CREDENTIAL_VALUE =
  /(?:\bbearer\s+[A-Z0-9._~+/-]+=*|\bsp[sk]_[A-Z0-9_-]{12,}|\b(?:access|refresh|id)[_-]?token\s*[:=])/iu;

export interface RedactionResult {
  readonly value: Readonly<Record<string, unknown>>;
  readonly removedFieldCount: number;
}

function normalizedKey(key: string): string {
  return key.replaceAll(/[^a-z0-9]/giu, "").toLocaleLowerCase("en-US");
}

function sensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (PROHIBITED_KEYS.has(normalized)) return true;
  return [
    "authorization",
    "cookie",
    "email",
    "otp",
    "password",
    "prompt",
    "secret",
    "token",
  ].some((part) => normalized.includes(part));
}

function safePrimitive(value: unknown): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return undefined;
  const normalized = value.slice(0, MAX_STRING_LENGTH);
  if (EMAIL_VALUE.test(normalized) || CREDENTIAL_VALUE.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function redactValue(
  value: unknown,
  depth: number,
  counter: { removed: number },
): unknown {
  if (depth > MAX_DEPTH) {
    counter.removed += 1;
    return undefined;
  }
  const primitive = safePrimitive(value);
  if (
    primitive !== undefined ||
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    if (primitive === undefined) counter.removed += 1;
    return primitive;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      const redacted = redactValue(item, depth + 1, counter);
      if (redacted !== undefined) output.push(redacted);
    }
    if (value.length > MAX_ARRAY_ITEMS) counter.removed += 1;
    return output;
  }
  if (typeof value !== "object") {
    counter.removed += 1;
    return undefined;
  }
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  for (const [key, item] of entries.slice(0, MAX_KEYS)) {
    if (sensitiveKey(key)) {
      counter.removed += 1;
      continue;
    }
    const redacted = redactValue(item, depth + 1, counter);
    if (redacted !== undefined) output[key.slice(0, 128)] = redacted;
  }
  if (entries.length > MAX_KEYS) counter.removed += 1;
  return output;
}

export function redactAuditMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): RedactionResult {
  const counter = { removed: 0 };
  const value = redactValue(metadata ?? {}, 0, counter);
  return {
    value:
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Readonly<Record<string, unknown>>)
        : {},
    removedFieldCount: counter.removed,
  };
}

export function containsSensitiveAuditData(value: unknown): boolean {
  const counter = { removed: 0 };
  redactValue(value, 0, counter);
  return counter.removed > 0;
}

export function isSensitiveAuditKey(key: string): boolean {
  return sensitiveKey(key);
}
