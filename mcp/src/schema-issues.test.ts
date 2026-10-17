import { createSchemaCompiler, formatMcpFnSchemaIssues } from "@mcpfn/core";
import { describe, expect, it } from "vitest";
import { normalizeMcpSchemaIssues } from "./schema-issues.js";
import { skillplaneMcpDeclaration } from "./server.js";

const SECRET = "argument-value-must-not-leak";
const BOUND = 424_242;

/** Malformed calls whose raw issues differ between the two engines. */
const FIXTURES: readonly (readonly [string, Record<string, unknown>])[] = [
  ["skills_list", { workspace: { id: "w" }, limit: BOUND }],
  ["skills_list", { workspace: { id: "w" }, workspace_id: SECRET }],
  ["skills_list", { workspace_id: SECRET }],
  ["skills_list", { workspace: { id: "w", extra: SECRET } }],
  ["skills_list", { workspace: { id: BOUND } }],
  ["skills_list", { workspace: { id: "w" }, visibility: [SECRET] }],
  ["skills_list", { workspace: SECRET }],
  ["skills_search", { query: "", workspace: { slug: SECRET.toUpperCase() } }],
  ["context_create", { metadata: { [SECRET]: BOUND }, slug: SECRET.toUpperCase() }],
];

function issuesFor(engine: "ajv" | "cfworker", tool: string, args: unknown) {
  const schema = skillplaneMcpDeclaration.registry.getListedTool(tool)?.inputSchema;
  if (!schema) throw new Error(`${tool} is not registered`);
  const validate = createSchemaCompiler(engine).compile(schema);
  expect(validate(args)).toBe(false);
  return normalizeMcpSchemaIssues(formatMcpFnSchemaIssues(validate.errors));
}

describe("schema issue normalization", () => {
  it.each(FIXTURES)(
    "reports identical value-free issues on both engines for %s",
    (tool, args) => {
      const ajv = issuesFor("ajv", tool, args);
      const cfworker = issuesFor("cfworker", tool, args);
      expect(cfworker).toEqual(ajv);
      const text = JSON.stringify(cfworker);
      expect(text).not.toContain(String(BOUND));
      expect(text).not.toContain(SECRET.toUpperCase());
      // A property name the caller sent may be named, never a property value.
      for (const issue of cfworker) {
        expect(issue.message).not.toContain(SECRET.toUpperCase());
      }
    },
  );

  it("names only undeclared properties as rejected", () => {
    expect(
      issuesFor("cfworker", "skills_list", { workspace: { id: "w" }, limit: BOUND }),
    ).not.toContainEqual(expect.objectContaining({ rejectedProperty: "limit" }));
    expect(
      issuesFor("cfworker", "skills_list", { workspace: { id: "w", extra: SECRET } }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaPath: "#/properties/workspace/anyOf/0/additionalProperties",
          rejectedProperty: "extra",
        }),
      ]),
    );
  });

  it("keeps an issue whose schema path was truncated to the root", () => {
    const issue = {
      path: "/",
      instancePath: "/",
      schemaPath: "#",
      keyword: "validation",
      message: SECRET,
    };
    expect(
      normalizeMcpSchemaIssues([
        issue,
        {
          ...issue,
          schemaPath: "#/required",
          keyword: "required",
          missingProperty: "q",
        },
      ]),
    ).toEqual([
      { ...issue, message: "must satisfy the validation constraint at #" },
      {
        ...issue,
        schemaPath: "#/required",
        keyword: "required",
        message: 'must have required property "q"',
        missingProperty: "q",
      },
    ]);
  });
});
