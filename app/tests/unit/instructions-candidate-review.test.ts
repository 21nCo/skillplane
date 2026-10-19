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
    vi.resetAllMocks();
  });

  it("finds an agent candidate's review by its proposed version beyond the newest 50", async () => {
    api.getSkillVersion.mockResolvedValue(
      version("agent", { source: "agent_amendment" }),
    );
    // Like the API, an unfiltered list holds only the newest 50 other reviews.
    api.listAmendmentReviews.mockImplementation(
      (options: { proposedVersionId?: string }) =>
        Promise.resolve(
          options.proposedVersionId === "agent"
            ? [{ review: review("agent") }]
            : Array.from({ length: 50 }, (_, index) => ({
                review: review(`newer-${index}`),
              })),
        ),
    );
    const controller = new CandidateReviewController(() => Promise.resolve());

    await controller.load(target("agent"));

    expect(api.listAmendmentReviews).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      skillId: "instructions-1",
      status: "all",
      proposedVersionId: "agent",
    });
    expect(controller.control).toEqual({ kind: "agent", review: review("agent") });
  });

  it("withholds publication when an agent candidate has no review", async () => {
    api.getSkillVersion.mockResolvedValue(
      version("agent", { source: "agent_amendment" }),
    );
    api.listAmendmentReviews.mockResolvedValue([] as AmendmentReviewDetail[]);
    const controller = new CandidateReviewController(() => Promise.resolve());

    await controller.load(target("agent"));

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

  it("reuses one idempotency key across retries of the same decision", async () => {
    api.getSkillVersion.mockResolvedValue(version("first"));
    api.publishCandidate.mockRejectedValueOnce(new Error("Network error"));
    api.rejectCandidate.mockRejectedValue(new Error("Network error"));
    const controller = new CandidateReviewController(() => Promise.resolve());
    await controller.load(target("first"));

    expect(await controller.publish()).toBe(false);
    expect(controller.actionError).toBe("Network error");
    expect(controller.version?.status).toBe("pending_review");
    api.publishCandidate.mockResolvedValueOnce(
      version("first", { status: "published" }),
    );
    expect(await controller.publish()).toBe(true);
    const [first, retry] = api.publishCandidate.mock.calls.map(
      ([options]) => (options as { idempotencyKey: string }).idempotencyKey,
    );
    expect(retry).toBe(first);

    // A different decision or reason is a new request.
    await controller.load(target("first"));
    await controller.reject("outdated");
    await controller.reject("outdated");
    await controller.reject("duplicate");
    const keys = api.rejectCandidate.mock.calls.map(
      ([options]) => (options as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[0]).not.toBe(first);
  });

  it("shows a decision that committed although its response was lost", async () => {
    api.getSkillVersion
      .mockResolvedValueOnce(version("first"))
      .mockResolvedValueOnce(version("first", { status: "published" }));
    api.publishCandidate.mockRejectedValueOnce(new Error("Network error"));
    const ondecided = vi.fn(() => Promise.resolve());
    const controller = new CandidateReviewController(ondecided);
    await controller.load(target("first"));

    expect(await controller.publish()).toBe(true);

    expect(controller.version?.status).toBe("published");
    expect(controller.actionError).toBeNull();
    expect(controller.busy).toBe(false);
    expect(controller.control).toEqual({ kind: "none" });
    expect(ondecided).toHaveBeenCalledWith(version("first", { status: "published" }));
  });

  it("keeps a saved decision when the refresh after it fails", async () => {
    api.getSkillVersion.mockResolvedValue(version("first"));
    api.publishCandidate.mockResolvedValueOnce(
      version("first", { status: "published" }),
    );
    const ondecided = vi
      .fn<(decided: SkillVersion) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Refresh failed"))
      .mockResolvedValueOnce(undefined);
    const controller = new CandidateReviewController(ondecided);
    await controller.load(target("first"));

    expect(await controller.publish()).toBe(true);

    expect(controller.version?.status).toBe("published");
    expect(controller.refreshError).toBe("Refresh failed");
    expect(controller.actionError).toBeNull();
    expect(controller.busy).toBe(false);

    // Retrying refreshes the saved decision without deciding again.
    await controller.refresh();

    expect(ondecided).toHaveBeenCalledTimes(2);
    expect(ondecided).toHaveBeenLastCalledWith(
      version("first", { status: "published" }),
    );
    expect(api.publishCandidate).toHaveBeenCalledTimes(1);
    expect(controller.refreshError).toBeNull();
    expect(controller.busy).toBe(false);
  });
});
