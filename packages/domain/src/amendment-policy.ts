import type { Pool, PoolClient } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest, type IdempotencyStore } from "./idempotency.js";
import type { Principal, ServicePrincipalScope } from "./principal.js";
import type { SemanticBump } from "./skill-versions.js";
import { withDomainTransaction } from "./transactions.js";
import { insertMutationAudit, type MutationAuditContext } from "./mutation-audit.js";

export interface ReviewRequiredPolicy {
  readonly mode: "review_required";
}

export interface TrustedAutoPublishRule {
  readonly credentialId: string;
  readonly requiredScopes: readonly ServicePrincipalScope[];
  readonly maxBump: SemanticBump;
  readonly allowedContextIds: readonly string[];
  readonly dailyLimit: number | null;
}

export interface TrustedAutoPublishPolicy {
  readonly mode: "trusted_auto_publish";
  readonly rules: readonly TrustedAutoPublishRule[];
}

export type AmendmentPolicy = ReviewRequiredPolicy | TrustedAutoPublishPolicy;

export interface AmendmentPolicyDecision {
  readonly outcome: "review_required" | "auto_publish";
  readonly reason:
    | "policy_requires_review"
    | "human_principal"
    | "credential_not_trusted"
    | "scope_requirement_not_met"
    | "bump_exceeds_limit"
    | "context_not_allowed"
    | "daily_limit_reached"
    | "trusted_rule_matched";
  readonly matchedRule: number | null;
}

const BUMP_RANK: Readonly<Record<SemanticBump, number>> = {
  patch: 1,
  minor: 2,
  major: 3,
};
const POLICY_KEYS = new Set(["mode", "rules"]);
const RULE_KEYS = new Set([
  "credentialId",
  "requiredScopes",
  "maxBump",
  "allowedContextIds",
  "dailyLimit",
]);
const SCOPES = new Set<ServicePrincipalScope>([
  "skills:read",
  "skills:write",
  "skills:amend",
  "contexts:read",
  "contexts:write",
  "members:read",
  "members:write",
  "analytics:read",
  "audit:read",
]);

function invalid(message: string, field = "policy"): never {
  throw new DomainError("AMENDMENT_POLICY_INVALID", message, 400, { field });
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function strictKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  if (key) invalid(`${field}.${key} is not supported`, `${field}.${key}`);
}

function shortText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 240) {
    return invalid(`${field} is required`, field);
  }
  return value.trim();
}

export function parseAmendmentPolicy(value: unknown): AmendmentPolicy {
  const policy = record(value, "policy");
  strictKeys(policy, POLICY_KEYS, "policy");
  if (policy.mode === "review_required") {
    if (policy.rules !== undefined) {
      invalid("Review-required policy cannot define trusted rules", "policy.rules");
    }
    return { mode: "review_required" };
  }
  if (policy.mode !== "trusted_auto_publish") {
    invalid(
      "policy.mode must be review_required or trusted_auto_publish",
      "policy.mode",
    );
  }
  if (
    !Array.isArray(policy.rules) ||
    policy.rules.length < 1 ||
    policy.rules.length > 50
  ) {
    invalid("Trusted auto-publish policy requires 1 to 50 rules", "policy.rules");
  }
  const rules = policy.rules.map((entry, index) => {
    const field = `policy.rules[${String(index)}]`;
    const rule = record(entry, field);
    strictKeys(rule, RULE_KEYS, field);
    if (!["patch", "minor", "major"].includes(String(rule.maxBump))) {
      invalid(`${field}.maxBump must be patch, minor, or major`, `${field}.maxBump`);
    }
    if (!Array.isArray(rule.requiredScopes) || rule.requiredScopes.length < 1) {
      invalid(`${field}.requiredScopes must not be empty`, `${field}.requiredScopes`);
    }
    const requiredScopes = [
      ...new Set(
        rule.requiredScopes.map((scope, scopeIndex) => {
          if (
            typeof scope !== "string" ||
            !SCOPES.has(scope as ServicePrincipalScope)
          ) {
            invalid(
              `${field}.requiredScopes contains an unsupported scope`,
              `${field}.requiredScopes[${String(scopeIndex)}]`,
            );
          }
          return scope as ServicePrincipalScope;
        }),
      ),
    ].sort();
    if (!requiredScopes.includes("skills:amend")) {
      invalid(
        `${field}.requiredScopes must include skills:amend`,
        `${field}.requiredScopes`,
      );
    }
    if (!Array.isArray(rule.allowedContextIds) || rule.allowedContextIds.length > 100) {
      invalid(
        `${field}.allowedContextIds must contain at most 100 contexts`,
        `${field}.allowedContextIds`,
      );
    }
    const allowedContextIds = [
      ...new Set(
        rule.allowedContextIds.map((contextId, contextIndex) =>
          shortText(contextId, `${field}.allowedContextIds[${String(contextIndex)}]`),
        ),
      ),
    ].sort();
    if (
      rule.dailyLimit !== null &&
      (!Number.isSafeInteger(rule.dailyLimit) ||
        (rule.dailyLimit as number) < 1 ||
        (rule.dailyLimit as number) > 10_000)
    ) {
      invalid(`${field}.dailyLimit must be null or 1 to 10,000`, `${field}.dailyLimit`);
    }
    return {
      credentialId: shortText(rule.credentialId, `${field}.credentialId`),
      requiredScopes,
      maxBump: rule.maxBump as SemanticBump,
      allowedContextIds,
      dailyLimit: rule.dailyLimit as number | null,
    } satisfies TrustedAutoPublishRule;
  });
  return { mode: "trusted_auto_publish", rules };
}

export function evaluateAmendmentPolicy(options: {
  readonly policy: AmendmentPolicy;
  readonly principal: Principal;
  readonly proposedBump: SemanticBump;
  readonly sourceContextId: string | null;
  readonly dailyPublicationCounts: ReadonlyMap<number, number>;
}): AmendmentPolicyDecision {
  if (options.policy.mode === "review_required") {
    return {
      outcome: "review_required",
      reason: "policy_requires_review",
      matchedRule: null,
    };
  }
  if (options.principal.kind !== "service") {
    return { outcome: "review_required", reason: "human_principal", matchedRule: null };
  }
  const servicePrincipal = options.principal;
  let nearest: AmendmentPolicyDecision["reason"] = "credential_not_trusted";
  for (const [index, rule] of options.policy.rules.entries()) {
    if (rule.credentialId !== servicePrincipal.servicePrincipalId) continue;
    nearest = "scope_requirement_not_met";
    if (
      !rule.requiredScopes.every((scope) => servicePrincipal.scopes.includes(scope))
    ) {
      continue;
    }
    nearest = "bump_exceeds_limit";
    if (BUMP_RANK[options.proposedBump] > BUMP_RANK[rule.maxBump]) continue;
    nearest = "context_not_allowed";
    if (
      rule.allowedContextIds.length > 0 &&
      (!options.sourceContextId ||
        !rule.allowedContextIds.includes(options.sourceContextId))
    ) {
      continue;
    }
    nearest = "daily_limit_reached";
    if (
      rule.dailyLimit !== null &&
      (options.dailyPublicationCounts.get(index) ?? 0) >= rule.dailyLimit
    ) {
      continue;
    }
    return {
      outcome: "auto_publish",
      reason: "trusted_rule_matched",
      matchedRule: index,
    };
  }
  return { outcome: "review_required", reason: nearest, matchedRule: null };
}

export class AmendmentPolicyService {
  constructor(
    private readonly pool: Pool,
    private readonly idempotency: IdempotencyStore,
  ) {}

  async get(options: {
    readonly skillId: string;
    readonly principal: Principal;
  }): Promise<AmendmentPolicy> {
    authorize(options.principal, "skills:read");
    const result = await this.pool.query<{ amendment_policy: unknown }>(
      `SELECT amendment_policy
         FROM skills
        WHERE id = $1 AND workspace_id = $2
        LIMIT 1`,
      [options.skillId, options.principal.workspaceId],
    );
    if (!result.rows[0]) {
      throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    }
    return parseAmendmentPolicy(result.rows[0].amendment_policy);
  }

  async update(options: {
    readonly skillId: string;
    readonly principal: Principal;
    readonly policy: unknown;
    readonly expectedUpdatedAt?: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly auditContext?: MutationAuditContext;
  }): Promise<AmendmentPolicy> {
    authorize(options.principal, "skills:publish");
    const policy = parseAmendmentPolicy(options.policy);
    const expectedUpdatedAt = (() => {
      if (options.expectedUpdatedAt === undefined) return undefined;
      const timestamp = Date.parse(options.expectedUpdatedAt);
      if (!Number.isFinite(timestamp)) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "expectedUpdatedAt must be an ISO 8601 timestamp",
          400,
          { field: "expectedUpdatedAt" },
        );
      }
      return new Date(timestamp).toISOString();
    })();
    await this.validateReferences(
      options.principal.workspaceId,
      options.skillId,
      policy,
    );
    const requestHash = await hashIdempotentRequest({
      operation: "skill.amendment-policy.update",
      skillId: options.skillId,
      policy,
      expectedUpdatedAt: expectedUpdatedAt ?? null,
    });
    const claim = await this.idempotency.claim<{ policy: AmendmentPolicy }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `skill.amendment-policy.update:${options.skillId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.policy;
    try {
      return await withDomainTransaction(
        this.pool,
        options.requestId,
        async ({ client }) => {
          const current = await client.query<{ updated_at: Date }>(
            `SELECT updated_at
               FROM skills
              WHERE id = $1 AND workspace_id = $2
              FOR UPDATE`,
            [options.skillId, options.principal.workspaceId],
          );
          const currentUpdatedAt = current.rows[0]?.updated_at;
          if (!currentUpdatedAt) {
            throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
          }
          if (
            expectedUpdatedAt !== undefined &&
            currentUpdatedAt.toISOString() !== expectedUpdatedAt
          ) {
            throw new DomainError(
              "SKILL_METADATA_CONFLICT",
              "Skill metadata changed after it was read",
              409,
              { currentUpdatedAt: currentUpdatedAt.toISOString() },
            );
          }
          const updated = await client.query(
            `UPDATE skills
                SET amendment_policy = $3,
                    updated_at = GREATEST(
                      clock_timestamp(),
                      updated_at + interval '1 millisecond'
                    )
              WHERE id = $1 AND workspace_id = $2
              RETURNING id`,
            [options.skillId, options.principal.workspaceId, policy],
          );
          if (!updated.rows[0]) {
            throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
          }
          await insertMutationAudit(client, options.principal, options.auditContext, {
            eventType: "skill.amendment_policy.updated",
            action: "skills:publish",
            requestId: options.requestId,
            resourceType: "skill",
            resourceId: options.skillId,
            skillId: options.skillId,
            metadata: {
              policy,
              previousUpdatedAt: currentUpdatedAt.toISOString(),
            },
          });
          await this.idempotency.complete(client, claim.identity, 200, { policy });
          return policy;
        },
      );
    } catch (error) {
      await this.idempotency.release(claim.identity).catch(() => undefined);
      throw error;
    }
  }

  private async validateReferences(
    workspaceId: string,
    skillId: string,
    policy: AmendmentPolicy,
  ): Promise<void> {
    if (policy.mode === "review_required") return;
    for (const [index, rule] of policy.rules.entries()) {
      const credential = await this.pool.query(
        `SELECT id
           FROM service_principals
          WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
        [rule.credentialId, workspaceId],
      );
      if (!credential.rows[0]) {
        invalid(
          `policy.rules[${String(index)}].credentialId is not an active workspace credential`,
          `policy.rules[${String(index)}].credentialId`,
        );
      }
      if (rule.allowedContextIds.length) {
        const contexts = await this.pool.query<{ id: string }>(
          `SELECT id
             FROM skill_contexts
            WHERE workspace_id = $1 AND skill_id = $2 AND id = ANY($3::text[])
              AND archived_at IS NULL`,
          [workspaceId, skillId, rule.allowedContextIds],
        );
        if (contexts.rowCount !== rule.allowedContextIds.length) {
          invalid(
            `policy.rules[${String(index)}].allowedContextIds contains an unavailable context`,
            `policy.rules[${String(index)}].allowedContextIds`,
          );
        }
      }
    }
  }
}

export async function countRuleAutoPublications(
  client: PoolClient,
  workspaceId: string,
  skillId: string,
): Promise<ReadonlyMap<number, number>> {
  const result = await client.query<{ rule_index: number; count: string }>(
    `SELECT (policy_decision->>'matchedRule')::integer AS rule_index,
            count(*)::text AS count
       FROM skill_versions
      WHERE workspace_id = $1 AND skill_id = $2
        AND source = 'agent_amendment'
        AND status = 'published'
        AND published_at >= date_trunc('day', now())
        AND policy_decision->>'outcome' = 'auto_publish'
        AND policy_decision->>'matchedRule' ~ '^[0-9]+$'
      GROUP BY 1`,
    [workspaceId, skillId],
  );
  return new Map(result.rows.map((row) => [row.rule_index, Number(row.count)]));
}
