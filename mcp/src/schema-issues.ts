import type { McpFnSchemaIssue } from "@mcpfn/core";

export const INVALID_ARGUMENTS_CODE = "MCPFN_INVALID_ARGUMENTS";

const ADDITIONAL_PROPERTIES = "/additionalProperties";

function pointerSegment(name: string): string {
  return name.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childInstancePath(parent: string, name: string): string {
  return `${parent === "/" ? "" : parent}/${pointerSegment(name)}`;
}

function atOrBeneath(path: string, parent: string): boolean {
  return parent === "/" || path === parent || path.startsWith(`${parent}/`);
}

/**
 * The message is rebuilt from structural fields only. Validator messages are
 * engine-specific and the Workers engine quotes argument values in them.
 */
function structuralMessage(issue: McpFnSchemaIssue): string {
  if (issue.keyword === "required" && issue.missingProperty) {
    return `must have required property "${issue.missingProperty}"`;
  }
  if (issue.keyword === "additionalProperties" && issue.rejectedProperty) {
    return `must not have unknown property "${issue.rejectedProperty}"`;
  }
  return `must satisfy the ${issue.keyword} constraint at ${issue.schemaPath}`;
}

/**
 * Reduces McpFn validation issues to the same value-free leaf failures on both
 * schema engines. Ajv runs under Node; @cfworker/json-schema runs on Workers
 * and additionally reports the subschema that contained a failure, a boolean
 * `false` schema, and an `additionalProperties` failure for a declared property
 * whose own value was invalid. Those additions are dropped so a client is never
 * told that a declared property is unknown.
 */
export function normalizeMcpSchemaIssues(
  issues: readonly McpFnSchemaIssue[],
): McpFnSchemaIssue[] {
  const rejectedLocations = new Set(
    issues.flatMap((issue) =>
      issue.keyword === "additionalProperties" && issue.rejectedProperty
        ? [childInstancePath(issue.instancePath, issue.rejectedProperty)]
        : [],
    ),
  );
  const leaves = issues.filter((issue) => {
    if (issue.keyword === "false") return !rejectedLocations.has(issue.instancePath);
    if (
      issue.keyword !== "additionalProperties" ||
      !issue.rejectedProperty ||
      !issue.schemaPath.endsWith(ADDITIONAL_PROPERTIES)
    ) {
      return true;
    }
    // A property is declared when some failure lies inside its own subschema.
    const declared = `${issue.schemaPath.slice(0, -ADDITIONAL_PROPERTIES.length)}/properties/${pointerSegment(issue.rejectedProperty)}/`;
    return !issues.some((other) => other.schemaPath.startsWith(declared));
  });
  return leaves
    .filter(
      (issue) =>
        issue.schemaPath === "#" ||
        !leaves.some(
          (other) =>
            other !== issue &&
            other.schemaPath.startsWith(`${issue.schemaPath}/`) &&
            atOrBeneath(other.instancePath, issue.instancePath),
        ),
    )
    .map((issue) => ({
      path: issue.instancePath,
      instancePath: issue.instancePath,
      schemaPath: issue.schemaPath,
      keyword: issue.keyword,
      message: structuralMessage(issue),
      ...(issue.rejectedProperty ? { rejectedProperty: issue.rejectedProperty } : {}),
      ...(issue.missingProperty ? { missingProperty: issue.missingProperty } : {}),
    }))
    .toSorted(
      (left, right) =>
        compare(left.instancePath, right.instancePath) ||
        compare(left.schemaPath, right.schemaPath) ||
        compare(left.rejectedProperty ?? "", right.rejectedProperty ?? "") ||
        compare(left.missingProperty ?? "", right.missingProperty ?? ""),
    );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaIssue(value: unknown): McpFnSchemaIssue | null {
  if (
    !isJsonObject(value) ||
    typeof value.instancePath !== "string" ||
    typeof value.schemaPath !== "string" ||
    typeof value.keyword !== "string"
  ) {
    return null;
  }
  return {
    path: value.instancePath,
    instancePath: value.instancePath,
    schemaPath: value.schemaPath,
    keyword: value.keyword,
    message: "",
    ...(typeof value.rejectedProperty === "string"
      ? { rejectedProperty: value.rejectedProperty }
      : {}),
    ...(typeof value.missingProperty === "string"
      ? { missingProperty: value.missingProperty }
      : {}),
  };
}

/** Rewrites McpFn's invalid-arguments payload in place; true when it changed. */
function normalizeInvalidArgumentsPayload(payload: unknown): boolean {
  if (
    !isJsonObject(payload) ||
    payload.ok !== false ||
    !isJsonObject(payload.error) ||
    payload.error.code !== INVALID_ARGUMENTS_CODE ||
    !isJsonObject(payload.error.details) ||
    !Array.isArray(payload.error.details.issues)
  ) {
    return false;
  }
  const issues = payload.error.details.issues.map(schemaIssue);
  payload.error.details.issues = normalizeMcpSchemaIssues(
    issues.filter((issue): issue is McpFnSchemaIssue => issue !== null),
  );
  return true;
}

/**
 * Applies normalizeMcpSchemaIssues to a tools/call error result. McpFn writes
 * the error payload into text content and, for tools without an output schema,
 * into structuredContent; both copies are rewritten.
 */
export function normalizeInvalidArgumentsResult(
  result: Record<string, unknown>,
): boolean {
  if (result.isError !== true) return false;
  let changed = false;
  if (normalizeInvalidArgumentsPayload(result.structuredContent)) changed = true;
  if (!Array.isArray(result.content)) return changed;
  for (const item of result.content) {
    if (!isJsonObject(item) || item.type !== "text" || typeof item.text !== "string") {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(item.text);
    } catch {
      continue;
    }
    if (normalizeInvalidArgumentsPayload(payload)) {
      item.text = JSON.stringify(payload, null, 2);
      changed = true;
    }
  }
  return changed;
}
