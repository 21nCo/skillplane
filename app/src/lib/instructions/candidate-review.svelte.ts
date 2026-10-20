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

// The review is looked up by its proposed version rather than searched in the
// newest-first history, which the API truncates.
async function findAgentReview(
  target: CandidateTarget,
  version: SkillVersion,
): Promise<AmendmentReview | null> {
  if (version.source !== "agent_amendment") return null;
  const reviews = await listAmendmentReviews({
    workspaceId: target.workspaceId,
    skillId: target.skillId,
    status: "all",
    proposedVersionId: version.id,
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
  private decisionKey: { readonly scope: string; readonly key: string } | null = null;

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
    this.decisionKey = null;
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

  // Called when the page is destroyed: pending loads and decisions stop changing
  // this view, while saved decisions still reach ondecided.
  dispose(): void {
    this.request += 1;
    this.target = null;
    this.decisionKey = null;
  }

  // Retries only the refresh (and a missing agent review) after a saved decision;
  // the decision is not repeated.
  async refresh(): Promise<void> {
    const request = this.request;
    const target = this.target;
    const version = this.version;
    if (!target || !version || this.busy || this.refreshError === null) return;
    this.busy = true;
    this.refreshError = null;
    try {
      const review = this.review ?? (await findAgentReview(target, version));
      if (request === this.request) this.review = review;
      await this.ondecided(version);
    } catch (cause) {
      if (request === this.request) {
        this.refreshError = message(cause, "The instructions could not refresh.");
      }
    }
    if (request === this.request) this.busy = false;
  }

  publish(): Promise<boolean> {
    return this.settle("human", ["publish"], (target, idempotencyKey) =>
      publishCandidate({
        workspaceId: target.workspaceId,
        skillId: target.skillId,
        versionId: target.versionId,
        idempotencyKey,
      }).then((version) => ({ version })),
    );
  }

  reject(reason: string): Promise<boolean> {
    return this.settle("human", ["reject", reason], (target, idempotencyKey) =>
      rejectCandidate({
        workspaceId: target.workspaceId,
        skillId: target.skillId,
        versionId: target.versionId,
        reason,
        idempotencyKey,
      }).then((version) => ({ version })),
    );
  }

  decideAmendment(decision: "approve" | "reject", reason: string): Promise<boolean> {
    const control = this.control;
    if (control.kind !== "agent") return Promise.resolve(false);
    const reviewId = control.review.id;
    const scope = [reviewId, decision, reason];
    return this.settle("agent", scope, async (target, idempotencyKey) => {
      const decided = await decideAmendmentReview({
        workspaceId: target.workspaceId,
        skillId: target.skillId,
        reviewId,
        decision,
        reason,
        idempotencyKey,
      });
      return { version: decided.candidate, review: decided.review };
    });
  }

  // One key per candidate decision, so a retry after a lost response replays the
  // saved decision instead of failing; a changed decision or reason starts anew.
  private keyFor(target: CandidateTarget, scope: readonly string[]): string {
    const serialized = JSON.stringify([target.versionId, ...scope]);
    if (this.decisionKey?.scope !== serialized) {
      this.decisionKey = { scope: serialized, key: crypto.randomUUID() };
    }
    return this.decisionKey.key;
  }

  // A failed request may still have committed. A candidate that left review is
  // returned as decided even when its review cannot be read; the review failure is
  // reported separately instead of hiding the saved decision.
  private async reconcile(target: CandidateTarget): Promise<{
    readonly version: SkillVersion;
    readonly review: AmendmentReview | null;
    readonly reviewError: string | null;
  } | null> {
    let current: SkillVersion;
    try {
      current = await getSkillVersion(
        target.workspaceId,
        target.skillId,
        target.versionId,
      );
    } catch {
      return null;
    }
    if (current.status === "pending_review") return null;
    try {
      return {
        version: current,
        review: await findAgentReview(target, current),
        reviewError: null,
      };
    } catch (cause) {
      return {
        version: current,
        review: null,
        reviewError: message(cause, "The amendment review could not be loaded."),
      };
    }
  }

  // A saved decision is always passed to ondecided, which owns the artifact's shared
  // history. Only the request that made it may change this controller's view state;
  // a later load or dispose() keeps the newer view.
  private async settle(
    kind: "human" | "agent",
    scope: readonly string[],
    operation: (
      target: CandidateTarget,
      idempotencyKey: string,
    ) => Promise<{
      readonly version: SkillVersion;
      readonly review?: AmendmentReview;
    }>,
  ): Promise<boolean> {
    const request = this.request;
    const target = this.target;
    if (!target || this.busy || this.loading || this.control.kind !== kind) {
      return false;
    }
    const owns = () => request === this.request;
    this.busy = true;
    this.actionError = null;
    this.refreshError = null;
    let version: SkillVersion;
    let reviewError: string | null = null;
    try {
      const decided = await operation(target, this.keyFor(target, scope));
      version = decided.version;
      if (owns()) {
        this.version = version;
        if (decided.review) this.review = decided.review;
      }
    } catch (cause) {
      const reconciled = await this.reconcile(target);
      if (!reconciled) {
        if (owns()) {
          this.actionError = message(cause, "The candidate state was not changed.");
          this.busy = false;
        }
        return false;
      }
      version = reconciled.version;
      reviewError = reconciled.reviewError;
      if (owns()) {
        this.version = version;
        this.review = reconciled.review;
      }
    }
    if (owns()) this.decisionKey = null;
    // The decision is saved; a failed refresh must not report it as unchanged.
    try {
      await this.ondecided(version);
    } catch (cause) {
      reviewError ??= message(cause, "The instructions could not refresh.");
    }
    if (owns()) {
      this.refreshError = reviewError;
      this.busy = false;
    }
    return true;
  }
}
