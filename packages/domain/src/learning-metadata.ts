import { stableJson } from "@skillplane/storage";
import { DomainError } from "./errors.js";

export const LEARNING_CONFIDENCES = ["low", "medium", "high"] as const;
export type LearningConfidence = (typeof LEARNING_CONFIDENCES)[number];

export interface LearningEvidence {
  readonly kind: string;
  readonly reference: string;
  readonly description: string;
}

export interface LearningValidation {
  readonly kind: string;
  readonly status: "passed" | "failed" | "not_run";
  readonly description: string;
}

export interface LearningExternalReference {
  readonly label: string;
  readonly url: string;
}

export interface LearningMetadata {
  readonly summary: string;
  readonly observation: string;
  readonly rationale: string;
  readonly confidence: LearningConfidence;
  readonly evidence: readonly LearningEvidence[];
  readonly evidenceUnavailableReason: string | null;
  readonly validation: readonly LearningValidation[];
  readonly validationNotRunReason: string | null;
  readonly sourceContextId: string | null;
  readonly sourceContextRevisionId: string | null;
  readonly sourceContextDigest: string | null;
  readonly tags: readonly string[];
  readonly externalReferences: readonly LearningExternalReference[];
  readonly extra: Readonly<Record<string, unknown>>;
}

const TOP_LEVEL_KEYS = new Set([
  "summary",
  "observation",
  "rationale",
  "confidence",
  "evidence",
  "evidenceUnavailableReason",
  "validation",
  "validationNotRunReason",
  "sourceContextId",
  "sourceContextRevisionId",
  "sourceContextDigest",
  "tags",
  "externalReferences",
  "extra",
]);

const SECRET_KEY =
  /(?:^|[_-])(secret|password|passwd|token|api[_-]?key|private[_-]?key|credential)(?:$|[_-])/iu;
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,})/u;

function invalid(message: string, field?: string): never {
  throw new DomainError(
    "LEARNING_METADATA_INVALID",
    message,
    400,
    field ? { field } : undefined,
  );
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  field: string,
  maximum: number,
  required = true,
): string | null {
  if (value === null || value === undefined) {
    if (!required) return null;
    return invalid(`${field} is required`, field);
  }
  if (typeof value !== "string") return invalid(`${field} must be text`, field);
  const normalized = value.trim();
  if ((!normalized && required) || normalized.length > maximum) {
    return invalid(
      `${field} must be ${required ? "between 1 and" : "at most"} ${String(maximum)} characters`,
      field,
    );
  }
  if (normalized && SECRET_VALUE.test(normalized)) {
    return invalid(`${field} appears to contain a secret and was not stored`, field);
  }
  return normalized || null;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const result = text(value, field, maximum);
  if (result === null) return invalid(`${field} is required`, field);
  return result;
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) invalid(`${field}.${unknown} is not supported`, `${field}.${unknown}`);
}

function validateExtraValue(
  value: unknown,
  field: string,
  depth: number,
  keyCounter: { count: number },
): unknown {
  if (depth > 8) invalid("learning.extra exceeds the maximum depth of 8", field);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${field} must contain finite numbers`, field);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 4_000) invalid(`${field} contains an oversized string`, field);
    if (SECRET_VALUE.test(value)) {
      invalid(`${field} appears to contain a secret and was not stored`, field);
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) invalid(`${field} contains too many entries`, field);
    return value.map((entry, index) =>
      validateExtraValue(entry, `${field}[${String(index)}]`, depth + 1, keyCounter),
    );
  }
  if (!value || typeof value !== "object") {
    invalid(`${field} contains an unsupported value`, field);
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    keyCounter.count += 1;
    if (keyCounter.count > 200) {
      invalid("learning.extra contains more than 200 keys", field);
    }
    if (key.length > 120) invalid(`${field} contains an oversized key`, field);
    if (SECRET_KEY.test(key)) {
      invalid(`${field}.${key} is secret-like and was not stored`, `${field}.${key}`);
    }
    result[key] = validateExtraValue(entry, `${field}.${key}`, depth + 1, keyCounter);
  }
  return result;
}

function evidence(value: unknown): readonly LearningEvidence[] {
  if (!Array.isArray(value) || value.length > 50) {
    invalid("learning.evidence must contain at most 50 entries", "learning.evidence");
  }
  const allowed = new Set(["kind", "reference", "description"]);
  return value.map((entry, index) => {
    const field = `learning.evidence[${String(index)}]`;
    const row = object(entry, field);
    strictKeys(row, allowed, field);
    return {
      kind: requiredText(row.kind, `${field}.kind`, 80),
      reference: requiredText(row.reference, `${field}.reference`, 2_000),
      description: requiredText(row.description, `${field}.description`, 2_000),
    };
  });
}

function validation(value: unknown): readonly LearningValidation[] {
  if (!Array.isArray(value) || value.length > 50) {
    invalid(
      "learning.validation must contain at most 50 entries",
      "learning.validation",
    );
  }
  const allowed = new Set(["kind", "status", "description"]);
  return value.map((entry, index) => {
    const field = `learning.validation[${String(index)}]`;
    const row = object(entry, field);
    strictKeys(row, allowed, field);
    if (!["passed", "failed", "not_run"].includes(String(row.status))) {
      invalid(`${field}.status must be passed, failed, or not_run`, `${field}.status`);
    }
    return {
      kind: requiredText(row.kind, `${field}.kind`, 80),
      status: row.status as LearningValidation["status"],
      description: requiredText(row.description, `${field}.description`, 2_000),
    };
  });
}

function externalReferences(value: unknown): readonly LearningExternalReference[] {
  if (!Array.isArray(value) || value.length > 20) {
    invalid(
      "learning.externalReferences must contain at most 20 entries",
      "learning.externalReferences",
    );
  }
  const allowed = new Set(["label", "url"]);
  return value.map((entry, index) => {
    const field = `learning.externalReferences[${String(index)}]`;
    const row = object(entry, field);
    strictKeys(row, allowed, field);
    const url = requiredText(row.url, `${field}.url`, 2_000);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return invalid(`${field}.url must be an absolute URL`, `${field}.url`);
    }
    if (!["https:", "http:"].includes(parsed.protocol)) {
      invalid(`${field}.url must use http or https`, `${field}.url`);
    }
    return {
      label: requiredText(row.label, `${field}.label`, 160),
      url: parsed.toString(),
    };
  });
}

export function parseLearningMetadata(value: unknown): LearningMetadata {
  const row = object(value, "learning");
  strictKeys(row, TOP_LEVEL_KEYS, "learning");
  if (
    typeof row.confidence !== "string" ||
    !(LEARNING_CONFIDENCES as readonly string[]).includes(row.confidence)
  ) {
    invalid("learning.confidence must be low, medium, or high", "learning.confidence");
  }
  const parsedEvidence = evidence(row.evidence ?? []);
  const evidenceUnavailableReason = text(
    row.evidenceUnavailableReason,
    "learning.evidenceUnavailableReason",
    2_000,
    false,
  );
  if (parsedEvidence.length === 0 && !evidenceUnavailableReason) {
    invalid(
      "learning.evidence requires an entry or an explicit unavailable reason",
      "learning.evidence",
    );
  }
  const parsedValidation = validation(row.validation ?? []);
  const validationNotRunReason = text(
    row.validationNotRunReason,
    "learning.validationNotRunReason",
    2_000,
    false,
  );
  if (parsedValidation.length === 0 && !validationNotRunReason) {
    invalid(
      "learning.validation requires an entry or an explicit not-run reason",
      "learning.validation",
    );
  }
  const tagsValue = row.tags ?? [];
  if (!Array.isArray(tagsValue) || tagsValue.length > 30) {
    invalid("learning.tags must contain at most 30 tags", "learning.tags");
  }
  const tags = [
    ...new Set(
      tagsValue.map((tag, index) =>
        text(tag, `learning.tags[${String(index)}]`, 80),
      ) as string[],
    ),
  ].sort((left, right) => left.localeCompare(right, "en"));
  const extra = validateExtraValue(row.extra ?? {}, "learning.extra", 1, {
    count: 0,
  }) as Record<string, unknown>;
  if (new TextEncoder().encode(stableJson(extra)).byteLength > 32 * 1024) {
    invalid("learning.extra exceeds 32 KiB", "learning.extra");
  }
  return {
    summary: requiredText(row.summary, "learning.summary", 2_000),
    observation: requiredText(row.observation, "learning.observation", 10_000),
    rationale: requiredText(row.rationale, "learning.rationale", 10_000),
    confidence: row.confidence as LearningConfidence,
    evidence: parsedEvidence,
    evidenceUnavailableReason,
    validation: parsedValidation,
    validationNotRunReason,
    sourceContextId: text(row.sourceContextId, "learning.sourceContextId", 240, false),
    sourceContextRevisionId: text(
      row.sourceContextRevisionId,
      "learning.sourceContextRevisionId",
      240,
      false,
    ),
    sourceContextDigest: text(
      row.sourceContextDigest,
      "learning.sourceContextDigest",
      80,
      false,
    ),
    tags,
    externalReferences: externalReferences(row.externalReferences ?? []),
    extra,
  };
}
