import { describe, expect, it } from "vitest";
import { collectDatafnStructuralResources } from "./resource-selectors.js";

describe("DataFn structural resource selectors", () => {
  it("ignores resource-shaped application data and filters", () => {
    expect([
      ...collectDatafnStructuralResources({
        resource: "skills",
        filters: { metadata: { resource: "workspaces" } },
        record: { resources: ["workspaceMemberships"] },
      }),
    ]).toEqual(["skills"]);
  });

  it("reads direct batch and transaction selectors", () => {
    expect([
      ...collectDatafnStructuralResources({
        steps: [
          { query: { resource: "skills" } },
          { mutation: { resource: "contextNotes" } },
          { resource: "skillContexts" },
        ],
      }),
    ]).toEqual(["skills", "contextNotes", "skillContexts"]);
  });
});
