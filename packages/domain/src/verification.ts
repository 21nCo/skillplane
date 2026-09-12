import { sha256Hex, stableJson } from "@skillplane/storage";
import type { Pool, PoolClient } from "pg";
import { authorize } from "./authorization.js";
import type { CompositionService } from "./composition-service.js";
import type { CompositionPlan, ResolvedClaim } from "./composition.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest, type IdempotencyStore } from "./idempotency.js";
import { insertPrincipalAudit } from "./mutation-audit.js";
import { principalAuditActor, type Principal } from "./principal.js";
import { withDomainTransaction } from "./transactions.js";

export interface EvidenceReference {
  type: string;
  uri: string;
  sha256: string;
  description: string;
  redacted: true;
}
export interface ClaimResult {
  claimId: string;
  status: "pass" | "fail" | "unknown";
  explanation: string;
  evidence: EvidenceReference[];
}
interface Mutation {
  principal: Principal;
  idempotencyKey: string;
  requestId: string;
  fencingEpoch?: number;
}
export interface VerificationRun {
  id: string;
  workspace_id: string;
  version_id: string;
  closure_digest: string;
  repository: string;
  commit_sha: string;
  environment: string;
  verifier_actor_id: string;
  verifier_actor_type: string;
  executor_actor_id: string;
  agent: string;
  model: string;
  status: "running" | "pass" | "fail" | "unknown";
  plan: CompositionPlan["verificationPlan"];
  evidence_manifest_digest: string | null;
  expires_at: Date;
}
function invalid(message: string): never {
  throw new DomainError("VERIFICATION_INVALID", message, 400);
}
function bounded(value: string, name: string, max = 2000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    invalid(`Invalid ${name}`);
  return value.trim();
}
export function evaluateVerification(
  claims: readonly ResolvedClaim[],
  results: readonly ClaimResult[],
): "pass" | "fail" | "unknown" {
  let unknown = false;
  for (const claim of claims.filter((c) => c.severity === "blocking")) {
    const result = results.find((r) => r.claimId === claim.namespacedId);
    if (result?.status === "fail") return "fail";
    if (
      !result ||
      result.status === "unknown" ||
      claim.requiredEvidence.some(
        (type) => !result.evidence.some((e) => e.type === type),
      )
    )
      unknown = true;
  }
  return unknown ? "unknown" : "pass";
}
export class VerificationService {
  constructor(
    readonly pool: Pool,
    readonly composition: CompositionService,
    readonly idempotency: IdempotencyStore,
  ) {}
  private async mutate<T>(
    options: Mutation,
    operation: string,
    payload: unknown,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    authorize(options.principal, "skills:read");
    const claim = await this.idempotency.claim<{ result: T }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation,
      key: options.idempotencyKey,
      requestHash: await hashIdempotentRequest(payload),
      fencingEpoch: options.fencingEpoch,
    });
    if (claim.state === "replay") return claim.responseBody.result;
    try {
      return await withDomainTransaction(
        this.pool,
        options.requestId,
        async ({ client }) => {
          const result = await work(client);
          await insertPrincipalAudit(client, options.principal, {
            eventType: operation,
            action: "skills:read",
            requestId: options.requestId,
            resourceType: "skill_verification",
            resourceId: (result as { id?: string }).id ?? "claim",
            metadata: {
              operation,
              status: (result as { status?: string }).status ?? null,
            },
          });
          await this.idempotency.complete(client, claim.identity, 200, { result });
          return result;
        },
        { fencingEpoch: options.fencingEpoch },
      );
    } catch (error) {
      await this.idempotency
        .release(claim.identity, options.fencingEpoch)
        .catch(() => undefined);
      throw error;
    }
  }
  async start(
    options: Mutation & {
      versionId: string;
      repository: string;
      commit: string;
      environment: string;
      executorActorId: string;
      agent: string;
      model: string;
    },
  ): Promise<VerificationRun> {
    const repository = bounded(options.repository, "repository");
    const environment = bounded(options.environment, "environment", 500);
    const executor = bounded(options.executorActorId, "executor identity", 160);
    if (executor === options.principal.actorId)
      invalid("Independent verification requires a different executor identity");
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(options.commit))
      invalid("An exact repository commit is required");
    const agent = bounded(options.agent, "agent", 160),
      model = bounded(options.model, "model", 160);
    return this.mutate(
      options,
      "skill.verification.started",
      {
        versionId: options.versionId,
        repository,
        environment,
        commit: options.commit,
        executor,
        agent,
        model,
      },
      async (client) => {
        const plan = await this.composition.resolve(
          options.versionId,
          options.principal,
          "verify",
        );
        if (plan.root.workspaceId !== options.principal.workspaceId)
          invalid("Start verification in the root skill workspace");
        const actor = principalAuditActor(options.principal);
        const result = await client.query<VerificationRun>(
          `INSERT INTO skill_verification_runs (id,workspace_id,version_id,closure_digest,repository,commit_sha,environment,verifier_actor_id,verifier_actor_type,executor_actor_id,agent,model,plan)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            `verification:${crypto.randomUUID()}`,
            options.principal.workspaceId,
            options.versionId,
            plan.closureDigest,
            repository,
            options.commit,
            environment,
            options.principal.actorId,
            actor.actorType,
            executor,
            agent,
            model,
            plan.verificationPlan,
          ],
        );
        const run = result.rows[0];
        if (!run) invalid("Verification run could not be created");
        return run;
      },
    );
  }
  private async run(
    client: Pick<Pool, "query"> | PoolClient,
    id: string,
    principal: Principal,
    lock = false,
    skillId?: string,
  ): Promise<VerificationRun> {
    authorize(principal, "skills:read");
    const result = await client.query<VerificationRun>(
      `SELECT * FROM skill_verification_runs WHERE id=$1 AND workspace_id=$2 AND expires_at > now() ${lock ? "FOR UPDATE" : ""}`,
      [id, principal.workspaceId],
    );
    const run = result.rows[0];
    if (!run) throw new DomainError("NOT_FOUND", "Verification run was not found", 404);
    const current = await this.composition.resolve(run.version_id, principal, "verify");
    if (skillId && current.root.skillId !== skillId)
      throw new DomainError("NOT_FOUND", "Verification run was not found", 404);
    if (current.closureDigest !== run.closure_digest)
      invalid("Verification closure no longer matches the run");
    if (
      lock &&
      (run.verifier_actor_id !== principal.actorId ||
        run.verifier_actor_type !== principalAuditActor(principal).actorType ||
        run.status !== "running")
    )
      invalid("Only the original verifier may update a running attestation");
    return run;
  }
  async get(id: string, principal: Principal) {
    const run = await this.run(this.pool, id, principal);
    const results = await this.pool.query<{
      namespaced_claim_id: string;
      status: ClaimResult["status"];
      explanation: string;
      evidence: EvidenceReference[];
    }>(
      "SELECT namespaced_claim_id,status,explanation,evidence FROM skill_verification_claim_results WHERE run_id=$1 AND workspace_id=$2 ORDER BY namespaced_claim_id",
      [id, principal.workspaceId],
    );
    return {
      ...run,
      results: results.rows.map((r) => ({
        claimId: r.namespaced_claim_id,
        status: r.status,
        explanation: r.explanation,
        evidence: r.evidence,
      })),
    };
  }
  async addEvidence(
    options: Mutation & { runId: string; skillId?: string; result: ClaimResult },
  ) {
    const result = options.result;
    bounded(result.claimId, "claim ID", 400);
    bounded(result.explanation, "explanation", 4000);
    if (
      !["pass", "fail", "unknown"].includes(result.status) ||
      !Array.isArray(result.evidence) ||
      result.evidence.length > 50
    )
      invalid("Invalid claim result");
    for (const e of result.evidence) {
      bounded(e.type, "evidence type", 100);
      bounded(e.description, "evidence description", 2000);
      bounded(e.uri, "evidence URI", 2000);
      if (
        !/^[a-f0-9]{64}$/.test(e.sha256) ||
        (e as { redacted: unknown }).redacted !== true
      )
        invalid("Evidence requires a SHA-256 digest and redaction acknowledgement");
      let uri: URL;
      try {
        uri = new URL(e.uri);
      } catch {
        return invalid("Evidence URI must be absolute");
      }
      if (
        !["https:", "urn:"].includes(uri.protocol) ||
        uri.username ||
        uri.password ||
        uri.search
      )
        invalid(
          "Use a redacted HTTPS or URN reference without credentials or query tokens",
        );
    }
    return this.mutate(
      options,
      "skill.verification.evidence_added",
      { runId: options.runId, result },
      async (client) => {
        const run = await this.run(
          client,
          options.runId,
          options.principal,
          true,
          options.skillId,
        );
        const claim = run.plan.claims.find((c) => c.namespacedId === result.claimId);
        if (!claim) invalid("Claim is outside the locked verification plan");
        if (
          result.status === "pass" &&
          claim.requiredEvidence.some(
            (type) => !result.evidence.some((e) => e.type === type),
          )
        )
          invalid("Passing claims require every declared evidence type");
        await client.query(
          `INSERT INTO skill_verification_claim_results (workspace_id,run_id,namespaced_claim_id,originating_version_id,status,explanation,evidence)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (run_id,namespaced_claim_id) DO UPDATE SET status=EXCLUDED.status,explanation=EXCLUDED.explanation,evidence=EXCLUDED.evidence`,
          [
            options.principal.workspaceId,
            run.id,
            result.claimId,
            claim.originatingVersionId,
            result.status,
            result.explanation,
            JSON.stringify(result.evidence),
          ],
        );
        return { id: run.id, result };
      },
    );
  }
  async complete(options: Mutation & { runId: string; skillId?: string }) {
    return this.mutate(
      options,
      "skill.verification.completed",
      { runId: options.runId },
      async (client) => {
        const run = await this.run(
          client,
          options.runId,
          options.principal,
          true,
          options.skillId,
        );
        for (const claim of run.plan.claims)
          await client.query(
            `INSERT INTO skill_verification_claim_results (workspace_id,run_id,namespaced_claim_id,originating_version_id,status,explanation,evidence) VALUES ($1,$2,$3,$4,'unknown','No evidence was submitted for this claim','[]'::jsonb) ON CONFLICT (run_id,namespaced_claim_id) DO NOTHING`,
            [
              options.principal.workspaceId,
              run.id,
              claim.namespacedId,
              claim.originatingVersionId,
            ],
          );
        const rows = await client.query<{
          namespaced_claim_id: string;
          status: ClaimResult["status"];
          explanation: string;
          evidence: EvidenceReference[];
        }>(
          "SELECT * FROM skill_verification_claim_results WHERE run_id=$1 AND workspace_id=$2 ORDER BY namespaced_claim_id",
          [run.id, options.principal.workspaceId],
        );
        const results = rows.rows.map((r) => ({
          claimId: r.namespaced_claim_id,
          status: r.status,
          explanation: r.explanation,
          evidence: r.evidence,
        }));
        const status = evaluateVerification(run.plan.claims, results);
        const digest = `sha256:${await sha256Hex(new TextEncoder().encode(stableJson({ closureDigest: run.closure_digest, repository: run.repository, commit: run.commit_sha, environment: run.environment, verifier: run.verifier_actor_id, results })))}`;
        const updated = await client.query<VerificationRun>(
          "UPDATE skill_verification_runs SET status=$2,evidence_manifest_digest=$3,completed_at=now() WHERE id=$1 RETURNING *",
          [run.id, status, digest],
        );
        const completed = updated.rows[0];
        if (!completed) invalid("Verification run could not be completed");
        return completed;
      },
    );
  }
}
