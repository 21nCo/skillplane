import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AmendmentReview,
  AmendmentReviewDetail,
  SkillVersion,
} from "../../src/lib/skills/types.js";

const api = vi.hoisted(() => ({
  decideAmendmentReview: vi.fn(),
  getSkillDiff: vi.fn(),
  getSkillVersion: vi.fn(),
  listAmendmentReviews: vi.fn(),
  publishCandidate: vi.fn(),
  rejectCandidate: vi.fn(),
}));

vi.mock("../../src/lib/skills/api.js", () => api);

import {
  CandidateReviewController,
  candidateControl,
} from "../../src/lib/instructions/candidate-review.svelte.js";

const target = (versionId: string) => ({
  workspaceId: "workspace-1",
  skillId: "instructions-1",
  versionId,
});

function version(id: string, overrides: Partial<SkillVersion> = {}): SkillVersion {
  return {
    id,
    skillId: "instructions-1",
    revision: 2,
    status: "pending_review",
    source: "human",
    baseVersionId: null,
    ...overrides,
  } as SkillVersion;
}

function review(proposedVersionId: string, id = `review-${proposedVersionId}`) {
  return { id, proposedVersionId, status: "pending" } as AmendmentReview;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("candidateControl", () => {
  it("never offers direct publication for an agent amendment", () => {
    const agent = version("agent", { source: "agent_amendment" });
    expect(candidateControl(agent, null)).toEqual({ kind: "agent_review_missing" });
    expect(candidateControl(agent, review("agent"))).toEqual({
      kind: "agent",
      review: review("agent"),
    });
    expect(candidateControl(version("human"), null)).toEqual({ kind: "human" });
    expect(
      candidateControl(
        version("old", { source: "agent_amendment", status: "published" }),
        null,
      ),
    ).toEqual({ kind: "none" });
  });
});

describe("CandidateReviewController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up a pending agent candidate in the pending queue and withholds publication when absent", async () => {
    api.getSkillVersion.mockResolvedValue(
      version("agent", { source: "agent_amendment" }),
    );
    // The newest reviews belong to other candidates; the selected one is not listed.
    api.listAmendmentReviews.mockResolvedValue([
      { review: review("other") } as AmendmentReviewDetail,
    ]);
    const controller = new CandidateReviewController(() => Promise.resolve());

    await controller.load(target("agent"));

    expect(api.listAmendmentReviews).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      skillId: "instructions-1",
      status: "pending",
    });
    expect(controller.control).toEqual({ kind: "agent_review_missing" });
    expect(await controller.publish()).toBe(false);
    expect(await controller.reject("no")).toBe(false);
    expect(api.publishCandidate).not.toHaveBeenCalled();
    expect(api.rejectCandidate).not.toHaveBeenCalled();
  });

  it("decides an agent candidate through its review", async () => {
    const candidate = version("agent", { source: "agent_amendment" });
    api.getSkillVersion.mockResolvedValue(candidate);
    api.listAmendmentReviews.mockResolvedValue([{ review: review("agent") }]);
    api.decideAmendmentReview.mockResolvedValue({
      review: { ...review("agent"), status: "approved" },
      candidate: { ...candidate, status: "published" },
    });
    const ondecided = vi.fn(() => Promise.resolve());
    const controller = new CandidateReviewController(ondecided);
    await controller.load(target("agent"));

    expect(await controller.publish()).toBe(false);
    expect(await controller.decideAmendment("approve", "validated")).toBe(true);

    expect(api.publishCandidate).not.toHaveBeenCalled();
    expect(api.decideAmendmentReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewId: "review-agent", decision: "approve" }),
    );
    expect(controller.version?.status).toBe("published");
    expect(controller.review?.status).toBe("approved");
    expect(ondecided).toHaveBeenCalledOnce();
  });

  it("drops a superseded load response after the route selects another version", async () => {
    const first = deferred<SkillVersion>();
    api.getSkillVersion
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(version("second", { revision: 3 }));
    const controller = new CandidateReviewController(() => Promise.resolve());

    const firstLoad = controller.load(target("first"));
    await controller.load(target("second"));
    first.resolve(version("first", { revision: 2 }));
    await firstLoad;

    expect(controller.version?.id).toBe("second");
    expect(controller.loading).toBe(false);
  });

  it("acts on the selected candidate and drops a decision that resolves after navigation", async () => {
    api.getSkillVersion.mockImplementation(async (_w: string, _s: string, id: string) =>
      version(id),
    );
    const published = deferred<SkillVersion>();
    api.publishCandidate.mockReturnValueOnce(published.promise);
    const ondecided = vi.fn(() => Promise.resolve());
    const controller = new CandidateReviewController(ondecided);
    await controller.load(target("first"));

    const decision = controller.publish();
    expect(api.publishCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "first" }),
    );
    await controller.load(target("second"));
    published.resolve(version("first", { status: "published" }));

    expect(await decision).toBe(false);
    expect(controller.version).toEqual(version("second"));
    expect(controller.busy).toBe(false);
    expect(ondecided).not.toHaveBeenCalled();

    api.publishCandidate.mockResolvedValueOnce(
      version("second", { status: "published" }),
    );
    expect(await controller.publish()).toBe(true);
    expect(api.publishCandidate).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: "second" }),
    );
  });
});
