import { describe, expect, it } from "vitest";
import { evaluateAmendmentPolicy, parseAmendmentPolicy } from "./amendment-policy.js";
import type { ServicePrincipal, UserPrincipal } from "./principal.js";

const service: ServicePrincipal = {
  kind: "service",
  actorId: "service-principal:trusted",
  servicePrincipalId: "service-principal:trusted",
  workspaceId: "workspace:one",
  role: "editor",
  scopes: ["skills:amend", "skills:read"],
};

const user: UserPrincipal = {
  kind: "user",
  actorId: "user:owner",
  userId: "user:owner",
  sessionId: "session:one",
  workspaceId: "workspace:one",
  role: "owner",
};

const policy = parseAmendmentPolicy({
  mode: "trusted_auto_publish",
  rules: [
    {
      credentialId: service.servicePrincipalId,
      requiredScopes: ["skills:amend"],
      maxBump: "minor",
      allowedContextIds: ["context:repo"],
      dailyLimit: 2,
    },
  ],
});

describe("amendment policy matrix", () => {
  it("defaults to review-required and never auto-publishes a human caller", () => {
    expect(
      evaluateAmendmentPolicy({
        policy: { mode: "review_required" },
        principal: service,
        proposedBump: "patch",
        sourceContextId: null,
        dailyPublicationCounts: new Map(),
      }),
    ).toMatchObject({
      outcome: "review_required",
      reason: "policy_requires_review",
    });
    expect(
      evaluateAmendmentPolicy({
        policy,
        principal: user,
        proposedBump: "patch",
        sourceContextId: "context:repo",
        dailyPublicationCounts: new Map(),
      }),
    ).toMatchObject({ outcome: "review_required", reason: "human_principal" });
  });

  it("auto-publishes only when credential, scopes, bump, context, and limit match", () => {
    expect(
      evaluateAmendmentPolicy({
        policy,
        principal: service,
        proposedBump: "minor",
        sourceContextId: "context:repo",
        dailyPublicationCounts: new Map([[0, 1]]),
      }),
    ).toEqual({
      outcome: "auto_publish",
      reason: "trusted_rule_matched",
      matchedRule: 0,
    });
  });

  it.each([
    ["major bump", { proposedBump: "major" as const }, "bump_exceeds_limit"],
    ["wrong context", { sourceContextId: "context:other" }, "context_not_allowed"],
    [
      "daily limit",
      { dailyPublicationCounts: new Map([[0, 2]]) },
      "daily_limit_reached",
    ],
  ])("routes %s to review without silent publication", (_label, override, reason) => {
    expect(
      evaluateAmendmentPolicy({
        policy,
        principal: service,
        proposedBump: "patch",
        sourceContextId: "context:repo",
        dailyPublicationCounts: new Map(),
        ...override,
      }),
    ).toMatchObject({ outcome: "review_required", reason });
  });
});
