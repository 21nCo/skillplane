<script lang="ts">
  import { getPostHog } from "$lib/analytics/posthog.client.js";
  import { Badge, Button, Textarea } from "@skillplane/ui";
  import type { AmendmentReview } from "./types.js";
  import { CheckIcon, XIcon } from "phosphor-svelte";

  let {
    review,
    canDecide,
    busy = false,
    ondecide,
  }: {
    review: AmendmentReview;
    canDecide: boolean;
    busy?: boolean;
    ondecide: (decision: "approve" | "reject", reason: string) => Promise<boolean>;
  } = $props();

  let reason = $state("");
  let selected = $state<"approve" | "reject" | null>(null);
  const reasonError = $derived(
    reason.length > 2_000
      ? "Keep the review rationale under 2,000 characters."
      : undefined,
  );
  const reviewerIdentity = $derived.by(() => {
    const actorType = review.reviewedByActorType;
    const actorId = review.reviewedByActorId;
    if (!actorType || !actorId) return "unknown";
    return actorId.startsWith(`${actorType}:`) ? actorId : `${actorType}:${actorId}`;
  });

  async function decide(decision: "approve" | "reject") {
    selected = decision;
    const saved = await ondecide(decision, reason.trim());
    if (saved) getPostHog()?.capture("candidate_review_decided", { decision });
    selected = null;
  }
</script>

<div class="decision" data-testid="review-decision">
  {#if review.status === "pending"}
    <div>
      <h3>Review decision</h3>
      <p>
        Record why this change is safe to publish or why it should return to the
        requesting agent.
      </p>
    </div>
    {#if canDecide}
      <Textarea
        label="Decision rationale"
        description="Required for both approval and rejection. This becomes immutable review history."
        placeholder="Summarize the validation and tradeoff behind this decision."
        rows={4}
        maxlength={2000}
        bind:value={reason}
        error={reasonError}
      />
      <div class="actions">
        <Button
          variant="danger"
          loading={busy && selected === "reject"}
          disabled={busy || !reason.trim() || Boolean(reasonError)}
          onclick={() => void decide("reject")}
        >
          {#snippet leading()}<XIcon weight="bold" />{/snippet}
          Reject candidate
        </Button>
        <Button
          variant="primary"
          loading={busy && selected === "approve"}
          disabled={busy || !reason.trim() || Boolean(reasonError)}
          onclick={() => void decide("approve")}
        >
          {#snippet leading()}<CheckIcon weight="bold" />{/snippet}
          Approve and publish
        </Button>
      </div>
    {:else}
      <div class="role-state">
        <Badge tone="warning">Admin or owner required</Badge>
        <span>Your access is read-only for publication decisions.</span>
      </div>
    {/if}
  {:else}
    <div class="resolved">
      <Badge tone={review.status === "approved" ? "success" : "danger"}>
        {review.status}
      </Badge>
      <div>
        <h3>{review.status === "approved" ? "Approved" : "Rejected"} review</h3>
        <p>{review.decisionReason ?? "No decision reason was recorded."}</p>
        {#if review.reviewedAt}
          <span>
            Authenticated reviewer
            <code>{reviewerIdentity}</code>
            · {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(review.reviewedAt))}
          </span>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .decision {
    display: grid;
    gap: var(--sp-space-4);
  }

  h3,
  p {
    margin: 0;
  }

  h3 {
    font-size: var(--sp-font-size-4);
  }

  p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    line-height: var(--sp-line-normal);
  }

  .actions,
  .role-state,
  .resolved {
    display: flex;
    align-items: center;
    gap: var(--sp-space-3);
  }

  .actions {
    justify-content: flex-end;
  }

  .role-state {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  .resolved {
    align-items: flex-start;
  }

  .resolved span {
    display: block;
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  code {
    font-family: var(--sp-font-mono);
  }

  @media (max-width: 36rem) {
    .actions {
      align-items: stretch;
      flex-direction: column-reverse;
    }
  }
</style>
