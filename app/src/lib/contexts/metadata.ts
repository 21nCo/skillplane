export function parseJsonObject(
  source: string,
  label: string,
): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function learningMetadata(
  summary: string,
  extraSource: string,
): Readonly<Record<string, unknown>> {
  const extra = parseJsonObject(extraSource, "Additional learning metadata");
  return {
    ...extra,
    summary: summary.trim(),
  };
}

export function extraLearningMetadata(
  metadata: Readonly<Record<string, unknown>>,
): string {
  const extra = { ...metadata };
  delete extra.summary;
  return JSON.stringify(extra, null, 2);
}

export function learningSummary(metadata: Readonly<Record<string, unknown>>): string {
  return typeof metadata.summary === "string" ? metadata.summary : "";
}
