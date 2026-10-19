import {
  decideAmendmentReview,
  getSkillDiff,
  getSkillVersion,
  listAmendmentReviews,
  publishCandidate,
  rejectCandidate,
} from "$lib/skills/api.js";
import type {
  AmendmentReview,
  SkillVersion,
  SkillVersionDiff,
} from "$lib/skills/types.js";

export interface CandidateTarget {
  readonly workspaceId: string;
  readonly skillId: string;
  readonly versionId: string;
}

// Agent amendments are decided only through their review, never by direct publication.
export type CandidateControl =
  | { readonly kind: "none" }
  | { readonly kind: "human" }
  | { readonly kind: "agent"; readonly review: AmendmentReview }
  | { readonly kind: "agent_review_missing" };

export function candidateControl(
  version: SkillVersion,
  review: AmendmentReview | null,
): CandidateControl {
  if (version.source === "agent_amendment") {
    if (review) return { kind: "agent", review };
    return version.status === "pending_review"
      ? { kind: "agent_review_missing" }
      : { kind: "none" };
  }
  return version.status === "pending_review" ? { kind: "human" } : { kind: "none" };
}

// A pending candidate's review is pending, so the pending queue is searched rather
// than the newest-first history, which the API truncates.
async function findAgentReview(
  target: CandidateTarget,
  version: SkillVersion,
): Promise<AmendmentReview | null> {
  if (version.source !== "agent_amendment") return null;
  const reviews = await listAmendmentReviews({
    workspaceId: target.workspaceId,
    skillId: target.skillId,
    status: version.status === "pending_review" ? "pending" : "all",
  });
  return (
    reviews.find((entry) => entry.review.proposedVersionId === version.id)?.review ??
    null
  );
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export class CandidateReviewController {
  version = $state<SkillVersion | null>(null);
  diff = $state<SkillVersionDiff | null>(null);
  review = $state<AmendmentReview | null>(null);
  loading = $state(true);
  error = $state<string | null>(null);
  busy = $state(false);
  actionError = $state<string | null>(null);
  refreshError = $state<string | null>(null);
  private request = 0;
  private target: CandidateTarget | null = null;

  constructor(private readonly ondecided: (version: SkillVersion) => Promise<void>) {}

  get control(): CandidateControl {
    return this.version
      ? candidateControl(this.version, this.review)
      : { kind: "none" };
  }

  // Only the latest load owns the page; a superseded response is dropped.
  async load(target: CandidateTarget): Promise<void> {
    const request = ++this.request;
    this.target = target;
    this.version = null;
    this.diff = null;
    this.review = null;
    this.loading = true;
    this.error = null;
    this.busy = false;
    this.actionError = null;
    this.refreshError = null;
    try {
      const selected = await getSkillVersion(
        target.workspaceId,
        target.skillId,
        target.versionId,
      );
      const [comparison, review] = await Promise.all([
        selected.baseVersionId
          ? getSkillDiff({
              workspaceId: target.workspaceId,
              skillId: target.skillId,
              fromVersionId: selected.baseVersionId,
              toVersionId: selected.id,
            })
          : null,
        findAgentReview(target, selected),
      ]);
      if (request !== this.request) return;
      this.version = selected;
      this.diff = comparison;
      this.review = review;
    } catch (cause) {
      if (request !== this.request) return;
      this.error = message(cause, "The version could not be loaded.");
    } finally {
      if (request === this.request) this.loading = false;
    }
  }

  retry(): void {
    if (this.target) void this.load(this.target);
  }

  publish(): Promise<boolean> {
    return this.settle("human", (target) =>
      publishCandidate({
        workspaceId: target.workspaceId,
        skillId: target.skillId,
        versionId: target.versionId,
        idempotencyKey: crypto.randomUUID(),
      }).then((version) => ({ version })),
    );
  }

  reject(reason: string): Promise<boolean> {
    return this.settle("human", (target) =>
      rejectCandidate({
        workspaceId: target.workspaceId,
        skillId: target.skillId,
        versionId: target.versionId,
        reason,
        idempotencyKey: crypto.randomUUID(),
      }).then((version) => ({ version })),
    );
  }

  decideAmendment(decision: "approve" | "reject", reason: string): Promise<boolean> {
    const control = this.control;
    if (control.kind !== "agent") return Promise.resolve(false);
    const reviewId = control.review.id;
    return this.settle("agent", async (target) => {
      const decided = await decideAmendmentReview({
        workspaceId: target.workspaceId,
        skillId: target.skillId,
        reviewId,
        decision,
        reason,
        idempotencyKey: crypto.randomUUID(),
      });
      return { version: decided.candidate, review: decided.review };
    });
  }

  // A decision belongs to the candidate it was made on; after navigation it is dropped.
  private async settle(
    kind: "human" | "agent",
    operation: (target: CandidateTarget) => Promise<{
      readonly version: SkillVersion;
      readonly review?: AmendmentReview;
    }>,
  ): Promise<boolean> {
    const request = this.request;
    const target = this.target;
    if (!target || this.busy || this.loading || this.control.kind !== kind) {
      return false;
    }
    this.busy = true;
    this.actionError = null;
    this.refreshError = null;
    let decided: Awaited<ReturnType<typeof operation>>;
    try {
      decided = await operation(target);
    } catch (cause) {
      if (request !== this.request) return false;
      this.actionError = message(cause, "The candidate state was not changed.");
      this.busy = false;
      return false;
    }
    if (request !== this.request) return false;
    this.version = decided.version;
    if (decided.review) this.review = decided.review;
    // The decision is saved; a failed refresh must not report it as unchanged.
    try {
      await this.ondecided(decided.version);
    } catch (cause) {
      if (request === this.request) {
        this.refreshError = message(cause, "The instructions could not refresh.");
      }
    }
    if (request === this.request) this.busy = false;
    return true;
  }
}
