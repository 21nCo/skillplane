import {
  authorize,
  canPerform,
  evaluateAmendmentPolicy,
  parseAmendmentPolicy,
  parseCallerDeclaration,
  type ServicePrincipal,
  type UserPrincipal,
} from "@skillplane/domain";
import { describe, expect, it } from "vitest";
import { requiredAction } from "../../src/middleware/authorization.js";

const scopedService: ServicePrincipal = {
  kind: "service",
  actorId: "service-principal:trusted",
  servicePrincipalId: "service-principal:trusted",
  workspaceId: "workspace:one",
  role: "editor",
  scopes: ["skills:read", "skills:amend"],
};
const unscopedService: ServicePrincipal = {
  ...scopedService,
  actorId: "service-principal:unscoped",
  servicePrincipalId: "service-principal:unscoped",
  scopes: ["skills:read"],
};
const editor: UserPrincipal = {
  kind: "user",
  actorId: "user:editor",
  userId: "user:editor",
  sessionId: "session:editor",
  workspaceId: "workspace:one",
  role: "editor",
};

describe("amendment policy security", () => {
  it("authorizes amendment scope independently from skill writes and publication", () => {
    expect(canPerform(scopedService, "skills:amend")).toBe(true);
    expect(canPerform(unscopedService, "skills:amend")).toBe(false);
    expect(canPerform(scopedService, "skills:write")).toBe(false);
    expect(canPerform(scopedService, "skills:publish")).toBe(false);
    expect(() => authorize(unscopedService, "skills:amend")).toThrow("required scope");
  });

  it("selects the restrictive action before generic skill route authorization", () => {
    expect(requiredAction("/api/v1/skills/skill:one/amendments", "POST")).toBe(
      "skills:amend",
    );
    expect(requiredAction("/api/v1/skills/skill:one/amendment-policy", "PUT")).toBe(
      "skills:publish",
    );
    expect(
      requiredAction("/api/v1/skills/skill:one/reviews/review:one/approve", "POST"),
    ).toBe("skills:publish");
    expect(requiredAction("/api/v1/skills/skill:one/candidates", "GET")).toBe(
      "skills:read",
    );
  });

  it("never lets declared user fields replace the authenticated user", () => {
    expect(() =>
      parseCallerDeclaration(
        {
          agent: "codex",
          model: "gpt-5",
          client: "mcp",
          runId: "run:one",
          forUserId: "user:other",
        },
        editor,
      ),
    ).toThrow(/cannot replace the authenticated user/u);
    expect(() =>
      parseCallerDeclaration(
        {
          agent: "codex",
          model: "gpt-5",
          client: "mcp",
          runId: "run:one",
          userId: "user:other",
        },
        editor,
      ),
    ).toThrow(/not supported/u);
  });

  it("requires every trust rule condition and falls back to review", () => {
    const policy = parseAmendmentPolicy({
      mode: "trusted_auto_publish",
      rules: [
        {
          credentialId: scopedService.servicePrincipalId,
          requiredScopes: ["skills:amend"],
          maxBump: "patch",
          allowedContextIds: ["context:one"],
          dailyLimit: 1,
        },
      ],
    });
    expect(
      evaluateAmendmentPolicy({
        policy,
        principal: scopedService,
        proposedBump: "patch",
        sourceContextId: "context:one",
        dailyPublicationCounts: new Map(),
      }).outcome,
    ).toBe("auto_publish");
    for (const result of [
      evaluateAmendmentPolicy({
        policy,
        principal: scopedService,
        proposedBump: "minor",
        sourceContextId: "context:one",
        dailyPublicationCounts: new Map(),
      }),
      evaluateAmendmentPolicy({
        policy,
        principal: scopedService,
        proposedBump: "patch",
        sourceContextId: "context:two",
        dailyPublicationCounts: new Map(),
      }),
      evaluateAmendmentPolicy({
        policy,
        principal: scopedService,
        proposedBump: "patch",
        sourceContextId: "context:one",
        dailyPublicationCounts: new Map([[0, 1]]),
      }),
      evaluateAmendmentPolicy({
        policy,
        principal: { ...scopedService, servicePrincipalId: "service-principal:other" },
        proposedBump: "patch",
        sourceContextId: "context:one",
        dailyPublicationCounts: new Map(),
      }),
    ]) {
      expect(result.outcome).toBe("review_required");
    }
  });
});
