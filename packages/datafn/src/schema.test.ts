import { describe, expect, it } from "vitest";
import {
  DATAFN_RESOURCE_NAMES,
  DATAFN_SECRET_TABLES,
  skillplaneDatafnSchema,
} from "./schema.js";

describe("Skillplane DataFn schema", () => {
  it("exposes the complete read model and no secret-bearing table", () => {
    expect(DATAFN_RESOURCE_NAMES).toEqual([
      "workspaces",
      "workspaceMemberships",
      "skills",
      "skillVersions",
      "skillContexts",
      "contextKnowledgeRevisions",
      "contextNotes",
      "contextNoteRevisions",
      "amendmentReviews",
      "analyticsDaily",
    ]);
    for (const secret of DATAFN_SECRET_TABLES) {
      expect(DATAFN_RESOURCE_NAMES).not.toContain(secret);
    }
  });

  it("declares every exposed resource read-only", () => {
    for (const resource of skillplaneDatafnSchema.resources) {
      expect(resource.permissions?.read?.fields.length).toBeGreaterThan(0);
      expect(resource.permissions?.write?.fields).toEqual([]);
    }
  });

  it("exposes workspace kind for personal and organization switching", () => {
    const workspaces = skillplaneDatafnSchema.resources.find(
      (resource) => resource.name === "workspaces",
    );
    expect(workspaces?.fields.map((field) => field.name)).toContain("kind");
    expect(workspaces?.permissions?.read?.fields).toContain("kind");
  });

  it("exposes the complete first-party skill version read contract", () => {
    const versions = skillplaneDatafnSchema.resources.find(
      (resource) => resource.name === "skillVersions",
    );
    for (const field of ["baseVersionId", "proposedBump", "bundleByteSize"]) {
      expect(versions?.fields.map((candidate) => candidate.name)).toContain(field);
      expect(versions?.permissions?.read?.fields).toContain(field);
    }
    expect(skillplaneDatafnSchema.relations).toContainEqual({
      from: "skills",
      to: "skillVersions",
      type: "many-one",
      relation: "currentVersion",
      fkField: "currentPublishedVersionId",
    });
  });
});
