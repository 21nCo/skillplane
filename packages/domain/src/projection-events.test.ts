import { describe, expect, it, vi } from "vitest";
import {
  enqueueCurrentSkillProjection,
  type SkillRecord,
  type SkillVersionRecord,
} from "./index.js";

const skill: SkillRecord = {
  id: "skill:one",
  workspaceId: "workspace:one",
  slug: "one",
  name: "One",
  description: "Public history",
  tags: [],
  visibility: "public",
  currentPublishedVersionId: "version:two",
  currentSemanticVersion: "2.0.0",
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

function version(id: string, semanticVersion: string): SkillVersionRecord {
  const digest = `sha256:${(semanticVersion === "1.0.0" ? "1" : "2").repeat(
    64,
  )}` as `sha256:${string}`;
  return {
    id,
    workspaceId: skill.workspaceId,
    skillId: skill.id,
    revision: semanticVersion === "1.0.0" ? 1 : 2,
    semanticVersion,
    status: "published",
    baseVersionId: null,
    proposedBump: null,
    source: "human",
    digest,
    objectKey: `bundles/${id}.zip`,
    byteSize: 1,
    manifest: {
      formatVersion: 1,
      digest,
      byteSize: 1,
      expandedByteSize: 1,
      fileCount: 0,
      files: [],
    },
    learningMetadata: {},
    amendmentOperations: [],
    callerDeclaration: {},
    policyDecision: {},
    changeSummary: "Published",
    createdByActorType: "user",
    createdByActorId: "user:one",
    createdByAgent: null,
    createdByModel: null,
    createdForUserId: null,
    publishedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

describe("public projection events", () => {
  it("reprojects every published version when a skill becomes public again", async () => {
    const first = version("version:one", "1.0.0");
    const current = version("version:two", "2.0.0");
    const payloads: Record<string, unknown>[] = [];
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      if (text.includes("jsonb_build_object")) {
        return {
          rows: [first, current].map((versionDocument) => ({
            search_text: "public history",
            version_document: versionDocument,
          })),
        };
      }
      if (text.includes("INSERT INTO regional_projection_outbox")) {
        payloads.push(JSON.parse(String(values?.[3])) as Record<string, unknown>);
      }
      return { rows: [] };
    });

    await enqueueCurrentSkillProjection(
      { query },
      { skill, includePublishedHistory: true },
    );

    expect(payloads.map((payload) => payload.versionId)).toEqual([
      "version:one",
      "version:two",
    ]);
    expect(payloads.map((payload) => payload.publishedAt)).toEqual([
      first.publishedAt,
      current.publishedAt,
    ]);
  });
});
