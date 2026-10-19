import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AmendmentReview,
  AmendmentReviewDetail,
  Skill,
  SkillVersion,
} from "../../src/lib/skills/types.js";

const api = vi.hoisted(() => ({
  decideAmendmentReview: vi.fn(),
  getSkill: vi.fn(),
  getSkillBySlug: vi.fn(),
  getSkillDiff: vi.fn(),
  getSkillVersion: vi.fn(),
  listAmendmentReviews: vi.fn(),
  listSkillVersions: vi.fn(),
  publishCandidate: vi.fn(),
  rejectCandidate: vi.fn(),
}));

vi.mock("../../src/lib/skills/api.js", () => api);

import {
  CandidateReviewController,
  candidateControl,
} from "../../src/lib/instructions/candidate-review.svelte.js";
import { SkillDetailStore } from "../../src/lib/skills/store.svelte.js";

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

  it("keeps the newer view but records a decision that resolves after navigation", async () => {
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

    // The saved decision still reaches the artifact's history.
    expect(await decision).toBe(true);
    expect(ondecided).toHaveBeenCalledWith(version("first", { status: "published" }));
    expect(controller.version).toEqual(version("second"));
    expect(controller.busy).toBe(false);

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

  it("records a lost-response decision whose review cannot be read", async () => {
    const candidate = version("agent", { source: "agent_amendment" });
    api.getSkillVersion
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce({ ...candidate, status: "published" });
    api.listAmendmentReviews
      .mockResolvedValueOnce([{ review: review("agent") }])
      .mockRejectedValueOnce(new Error("Reviews unavailable"));
    api.decideAmendmentReview.mockRejectedValueOnce(new Error("Network error"));
    const ondecided = vi.fn(() => Promise.resolve());
    const controller = new CandidateReviewController(ondecided);
    await controller.load(target("agent"));

    expect(await controller.decideAmendment("approve", "validated")).toBe(true);

    expect(controller.version?.status).toBe("published");
    expect(controller.actionError).toBeNull();
    expect(controller.refreshError).toBe("Reviews unavailable");
    expect(controller.busy).toBe(false);
    expect(ondecided).toHaveBeenCalledWith({ ...candidate, status: "published" });

    // Retrying reads the review again without deciding again.
    api.listAmendmentReviews.mockResolvedValueOnce([
      { review: { ...review("agent"), status: "approved" } },
    ]);
    await controller.refresh();
    expect(controller.review?.status).toBe("approved");
    expect(controller.refreshError).toBeNull();
    expect(api.decideAmendmentReview).toHaveBeenCalledTimes(1);
  });
});

describe("candidate decisions and the shared detail store", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function artifact(id: string, slug: string) {
    return {
      id,
      workspaceId: "workspace-1",
      slug,
      name: slug,
      kind: "instructions",
      currentPublishedVersionId: null,
    } as unknown as Skill;
  }

  // Wires the controller to the store exactly as the version page does.
  async function storeHolding(id: string, slug: string, versions: SkillVersion[]) {
    api.getSkillBySlug.mockResolvedValueOnce(artifact(id, slug));
    api.listSkillVersions.mockResolvedValueOnce(versions);
    const store = new SkillDetailStore();
    await store.load("workspace-1", slug);
    const controller = new CandidateReviewController(async (decided) => {
      store.replaceVersion(decided);
      await store.refreshIfOwner(decided.skillId);
    });
    return { store, controller };
  }

  it.each(["human", "agent"] as const)(
    "keeps a %s decision for document A out of document B after the page is destroyed",
    async (source) => {
      const pending = version("a-2", {
        source: source === "agent" ? "agent_amendment" : "human",
      });
      api.getSkillVersion.mockResolvedValueOnce(pending);
      api.listAmendmentReviews.mockResolvedValueOnce([{ review: review("a-2") }]);
      const { store, controller } = await storeHolding("instructions-1", "a", [
        pending,
      ]);
      await controller.load(target("a-2"));
      const decided = deferred<SkillVersion>();
      if (source === "agent") {
        api.decideAmendmentReview.mockReturnValueOnce(
          decided.promise.then((candidate) => ({
            candidate,
            review: { ...review("a-2"), status: "approved" },
          })),
        );
      } else {
        api.publishCandidate.mockReturnValueOnce(decided.promise);
      }
      const decision =
        source === "agent"
          ? controller.decideAmendment("approve", "validated")
          : controller.publish();

      // The user leaves A's version page for document B.
      controller.dispose();
      const other = version("b-1", { skillId: "instructions-2", status: "published" });
      api.getSkillBySlug.mockResolvedValueOnce(artifact("instructions-2", "b"));
      api.listSkillVersions.mockResolvedValueOnce([other]);
      await store.load("workspace-1", "b");
      decided.resolve({ ...pending, status: "published" });

      expect(await decision).toBe(true);
      expect(store.skill?.id).toBe("instructions-2");
      expect(store.versions).toEqual([other]);
      expect(api.getSkill).not.toHaveBeenCalled();
      expect(controller.refreshError).toBeNull();
    },
  );

  it("updates the same document's history when the decision resolves after another version loads", async () => {
    const first = version("first");
    const second = version("second", { revision: 3 });
    const { store, controller } = await storeHolding("instructions-1", "a", [
      second,
      first,
    ]);
    api.getSkillVersion.mockImplementation(
      async (_w: string, _s: string, id: string) => (id === "first" ? first : second),
    );
    await controller.load(target("first"));
    const published = deferred<SkillVersion>();
    api.publishCandidate.mockReturnValueOnce(published.promise);
    const decision = controller.publish();

    await controller.load(target("second"));
    const refreshed = { ...first, status: "published" as const };
    api.getSkill.mockResolvedValueOnce(artifact("instructions-1", "a"));
    api.listSkillVersions.mockResolvedValueOnce([second, refreshed]);
    published.resolve(refreshed);

    expect(await decision).toBe(true);
    expect(store.versions.find((entry) => entry.id === "first")?.status).toBe(
      "published",
    );
    expect(api.getSkill).toHaveBeenCalledWith("workspace-1", "instructions-1");
    expect(controller.version).toEqual(second);
    expect(controller.busy).toBe(false);
  });
});
