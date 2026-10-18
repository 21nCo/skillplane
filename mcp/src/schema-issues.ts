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
  if (issue.keyword === "required" && issue.missingProperty !== undefined) {
    return `must have required property "${issue.missingProperty}"`;
  }
  if (
    issue.keyword === "additionalProperties" &&
    issue.rejectedProperty !== undefined
  ) {
    return `must not have unknown property "${issue.rejectedProperty}"`;
  }
  return `must satisfy the ${issue.keyword} constraint at ${issue.schemaPath}`;
}

/**
 * McpFn 0.0.5 treats an empty property name as absent. Both engines name every
 * property an `additionalProperties` schema rejects, so a rejection without a
 * name rejected the property named "".
 */
function restoreEmptyPropertyName(issue: McpFnSchemaIssue): McpFnSchemaIssue {
  return issue.keyword === "additionalProperties" &&
    issue.rejectedProperty === undefined &&
    issue.schemaPath.endsWith(ADDITIONAL_PROPERTIES)
    ? { ...issue, rejectedProperty: "" }
    : issue;
}

const COMBINATOR_BRANCH = /^(.*\/(?:anyOf|oneOf))\/(\d+)\/additionalProperties$/u;

/**
 * True when an `anyOf`/`oneOf` branch rejects a property that a sibling branch
 * accepted. Every branch of a failed combinator reports all of its failures,
 * so the property is declared there and is not unknown to the tool.
 */
function acceptedBySiblingBranch(
  issue: McpFnSchemaIssue,
  issues: readonly McpFnSchemaIssue[],
  leaves: readonly McpFnSchemaIssue[],
): boolean {
  const group = COMBINATOR_BRANCH.exec(issue.schemaPath)?.[1];
  if (group === undefined) return false;
  const branches = new Set(
    issues.flatMap((other) => {
      if (!other.schemaPath.startsWith(`${group}/`)) return [];
      const branch = /^\d+(?=\/|$)/u.exec(other.schemaPath.slice(group.length + 1));
      return branch ? [branch[0]] : [];
    }),
  );
  return [...branches].some(
    (branch) =>
      !leaves.some(
        (other) =>
          other.keyword === "additionalProperties" &&
          other.instancePath === issue.instancePath &&
          other.schemaPath === `${group}/${branch}${ADDITIONAL_PROPERTIES}` &&
          other.rejectedProperty === issue.rejectedProperty,
      ),
  );
}

/**
 * Reduces McpFn validation issues to the same value-free leaf failures on both
 * schema engines. Ajv runs under Node; @cfworker/json-schema runs on Workers
 * and additionally reports the subschema that contained a failure, a boolean
 * `false` schema, and an `additionalProperties` failure for a declared property
 * whose own value was invalid. Those additions are dropped, as is a combinator
 * branch's rejection of a property its sibling branch declares, so a client is
 * never told that a declared property is unknown.
 */
export function normalizeMcpSchemaIssues(
  reported: readonly McpFnSchemaIssue[],
): McpFnSchemaIssue[] {
  const issues = reported.map(restoreEmptyPropertyName);
  const rejectedLocations = new Set(
    issues.flatMap((issue) =>
      issue.keyword === "additionalProperties" && issue.rejectedProperty !== undefined
        ? [childInstancePath(issue.instancePath, issue.rejectedProperty)]
        : [],
    ),
  );
  const declaredLeaves = issues.filter((issue) => {
    if (issue.keyword === "false") return !rejectedLocations.has(issue.instancePath);
    if (
      issue.keyword !== "additionalProperties" ||
      issue.rejectedProperty === undefined ||
      !issue.schemaPath.endsWith(ADDITIONAL_PROPERTIES)
    ) {
      return true;
    }
    // A property is declared when some failure lies inside its own subschema.
    const declared = `${issue.schemaPath.slice(0, -ADDITIONAL_PROPERTIES.length)}/properties/${pointerSegment(issue.rejectedProperty)}/`;
    return !issues.some((other) => other.schemaPath.startsWith(declared));
  });
  const leaves = declaredLeaves.filter(
    (issue) =>
      issue.keyword !== "additionalProperties" ||
      !acceptedBySiblingBranch(issue, issues, declaredLeaves),
  );
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
      ...(issue.rejectedProperty !== undefined
        ? { rejectedProperty: issue.rejectedProperty }
        : {}),
      ...(issue.missingProperty !== undefined
        ? { missingProperty: issue.missingProperty }
        : {}),
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
