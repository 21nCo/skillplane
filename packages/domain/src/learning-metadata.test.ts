import { describe, expect, it } from "vitest";
import { DomainError } from "./errors.js";
import { parseLearningMetadata } from "./learning-metadata.js";

function validLearning() {
  return {
    summary: "Prefer exact review-thread evidence",
    observation: "Repository review conclusions were stale without live thread state.",
    rationale: "The instruction makes unresolved feedback part of every review.",
    confidence: "high",
    evidence: [
      {
        kind: "test",
        reference: "reviewThreads:42",
        description: "A stale conclusion was reproduced.",
      },
    ],
    validation: [
      {
        kind: "integration",
        status: "passed",
        description: "Review workflow retained the evidence.",
      },
    ],
    sourceContextId: "context:repo",
    tags: ["review", "evidence", "review"],
    externalReferences: [
      { label: "Review API", url: "https://example.test/reviews/42" },
    ],
    extra: { source: "agent-observation", attempts: 2 },
  };
}

function expectCode(operation: () => unknown, code: string) {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("structured learning metadata", () => {
  it("normalizes complete evidence, validation, tags, references, and extras", () => {
    expect(parseLearningMetadata(validLearning())).toMatchObject({
      summary: "Prefer exact review-thread evidence",
      confidence: "high",
      sourceContextId: "context:repo",
      sourceContextRevisionId: null,
      sourceContextDigest: null,
      tags: ["evidence", "review"],
      extra: { source: "agent-observation", attempts: 2 },
    });
  });

  it("requires rationale and an explicit explanation for absent evidence", () => {
    const missingRationale = { ...validLearning(), rationale: "" };
    expectCode(
      () => parseLearningMetadata(missingRationale),
      "LEARNING_METADATA_INVALID",
    );
    const noEvidence = {
      ...validLearning(),
      evidence: [],
      evidenceUnavailableReason: "The source system was unavailable.",
    };
    expect(parseLearningMetadata(noEvidence).evidenceUnavailableReason).toContain(
      "unavailable",
    );
  });

  it("requires validation or a concrete not-run reason", () => {
    expectCode(
      () => parseLearningMetadata({ ...validLearning(), validation: [] }),
      "LEARNING_METADATA_INVALID",
    );
    expect(
      parseLearningMetadata({
        ...validLearning(),
        validation: [],
        validationNotRunReason: "The isolated runner had no browser binary.",
      }).validationNotRunReason,
    ).toContain("browser");
  });

  it("rejects depth nine, oversized metadata, and secret-like content", () => {
    let nested: Record<string, unknown> = { value: true };
    for (let index = 0; index < 9; index += 1) nested = { nested };
    expectCode(
      () => parseLearningMetadata({ ...validLearning(), extra: nested }),
      "LEARNING_METADATA_INVALID",
    );
    expectCode(
      () =>
        parseLearningMetadata({
          ...validLearning(),
          extra: { note: "x".repeat(33 * 1024) },
        }),
      "LEARNING_METADATA_INVALID",
    );
    expectCode(
      () =>
        parseLearningMetadata({
          ...validLearning(),
          extra: { api_token: "should-never-persist" },
        }),
      "LEARNING_METADATA_INVALID",
    );
  });
});
