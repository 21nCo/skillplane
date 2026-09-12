import { DomainError } from "@skillplane/domain";
import {
  verificationStartFieldsSchema,
  verificationResultSchema,
} from "@skillplane/mcp-schema";
import type { Context, Hono } from "hono";
import type { ApiEnvironment, ApiServices } from "../context.js";
import { success } from "../envelopes.js";
import { registerResourceRoutes } from "../resource-routing.js";
import {
  publicSkillVersion,
  parseStringField,
  readJsonObject,
  requireIdempotencyKey,
  requirePrincipal,
  routingEpoch,
} from "./shared.js";
function requireServices(c: Context<ApiEnvironment>): ApiServices {
  const s = c.get("services");
  if (!s)
    throw new DomainError("SERVICE_UNAVAILABLE", "Skill service is unavailable", 503);
  return s;
}
export function registerCompositionRoutes(app: Hono<ApiEnvironment>) {
  app.get("/api/v1/skills/:skillId/versions/:versionId/resolve", async (c) => {
    const services = c.get("services");
    if (!services) throw new DomainError("NOT_FOUND", "Skill was not found", 404);
    const purpose = c.req.query("purpose") ?? "execute";
    if (purpose !== "execute" && purpose !== "verify")
      throw new DomainError("VALIDATION_FAILED", "Invalid resolution purpose", 400);
    const plan = await services.compositionService.resolve(
      c.req.param("versionId"),
      c.get("principal"),
      purpose,
      Boolean(c.get("principal")),
    );
    if (plan.root.skillId !== c.req.param("skillId"))
      throw new DomainError("NOT_FOUND", "Skill was not found", 404);
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, { plan }));
  });
  app.get(
    "/api/v1/skills/:skillId/versions/:versionId/dependency-upgrade",
    async (c) => {
      const s = requireServices(c);
      const principal = requirePrincipal(c);
      return c.json(
        success(
          c,
          await s.compositionService.upgradePreview(
            c.req.param("versionId"),
            principal,
            c.req.param("skillId"),
          ),
        ),
      );
    },
  );
  app.post("/api/v1/skills/:skillId/versions/:versionId/lifecycle", async (c) => {
    const fields = await readJsonObject(c);
    const state = fields.state;
    if (state !== "deprecated" && state !== "revoked")
      throw new DomainError("VALIDATION_FAILED", "Invalid lifecycle state", 400);
    const result = await requireServices(c).versionLifecycleService.set({
      skillId: c.req.param("skillId"),
      versionId: c.req.param("versionId"),
      state,
      reason: parseStringField(fields.reason, "reason"),
      principal: requirePrincipal(c),
      idempotencyKey: requireIdempotencyKey(c),
      requestId: c.get("requestId"),
      fencingEpoch: routingEpoch(c),
    });
    return c.json(success(c, result));
  });
  app.get("/api/v1/skills/:skillId/versions/:versionId/dependents", async (c) => {
    const s = requireServices(c);
    const principal = requirePrincipal(c);
    await s.skillVersionService.get({
      skillId: c.req.param("skillId"),
      versionId: c.req.param("versionId"),
      principal,
    });
    const rows = await s.database.pool.query(
      "SELECT DISTINCT d.root_version_id,s.slug AS skill_slug,v.semantic_version FROM skill_version_dependencies d JOIN skill_versions v ON v.id=d.root_version_id JOIN skills s ON s.id=v.skill_id WHERE d.child_version_id=$1 AND d.workspace_id=$2 ORDER BY d.root_version_id LIMIT 100",
      [c.req.param("versionId"), principal.workspaceId],
    );
    return c.json(success(c, { dependents: rows.rows, scope: "current-workspace" }));
  });
  app.post(
    "/api/v1/skills/:skillId/versions/:versionId/dependency-upgrade",
    async (c) => {
      const s = requireServices(c);
      const principal = requirePrincipal(c);
      const bundle = await s.compositionService.upgradeBundle(
        c.req.param("versionId"),
        c.req.param("skillId"),
        principal,
      );
      const version = await s.skillVersionService.createCandidate({
        skillId: c.req.param("skillId"),
        baseVersionId: c.req.param("versionId"),
        principal,
        archiveBytes: bundle.bytes,
        proposedBump: "minor",
        changeSummary: "Upgrade locked skill dependencies",
        idempotencyKey: requireIdempotencyKey(c),
        requestId: c.get("requestId"),
        fencingEpoch: routingEpoch(c),
      });
      await registerResourceRoutes(s, principal.workspaceId, [
        { resourceType: "skill_version", resourceId: version.id },
      ]);
      return c.json(success(c, { version: publicSkillVersion(version) }), 201);
    },
  );
  app.post(
    "/api/v1/skills/:skillId/versions/:versionId/verification-runs",
    async (c) => {
      const s = requireServices(c);
      const principal = requirePrincipal(c);
      const fields = verificationStartFieldsSchema.safeParse(await readJsonObject(c));
      if (!fields.success)
        throw new DomainError("VALIDATION_FAILED", "Invalid verification target", 400);
      const plan = await s.compositionService.resolve(
        c.req.param("versionId"),
        principal,
        "verify",
      );
      if (plan.root.skillId !== c.req.param("skillId"))
        throw new DomainError("NOT_FOUND", "Skill was not found", 404);
      const run = await s.verificationService.start({
        ...fields.data,
        versionId: plan.root.versionId,
        principal,
        idempotencyKey: requireIdempotencyKey(c),
        requestId: c.get("requestId"),
        fencingEpoch: routingEpoch(c),
      });
      return c.json(success(c, { run }), 201);
    },
  );
  app.get("/api/v1/skills/:skillId/verification-runs", async (c) => {
    const s = requireServices(c);
    const principal = requirePrincipal(c);
    const rows = await s.database.pool.query(
      "SELECT id,version_id,status,commit_sha,environment,started_at,completed_at FROM skill_verification_runs WHERE workspace_id=$1 AND version_id IN (SELECT id FROM skill_versions WHERE skill_id=$2 AND workspace_id=$1) AND expires_at>now() ORDER BY started_at DESC LIMIT 50",
      [principal.workspaceId, c.req.param("skillId")],
    );
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, { runs: rows.rows }));
  });
  app.get("/api/v1/skills/:skillId/verification-runs/:runId", async (c) => {
    const s = requireServices(c);
    const principal = requirePrincipal(c);
    const run = await s.verificationService.get(c.req.param("runId"), principal);
    const plan = await s.compositionService.resolve(
      run.version_id,
      principal,
      "verify",
    );
    if (plan.root.skillId !== c.req.param("skillId"))
      throw new DomainError("NOT_FOUND", "Verification run was not found", 404);
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, { run }));
  });
  app.post("/api/v1/skills/:skillId/verification-runs/:runId/evidence", async (c) => {
    const parsed = verificationResultSchema.safeParse(await readJsonObject(c));
    if (!parsed.success)
      throw new DomainError("VALIDATION_FAILED", "Invalid claim evidence", 400);
    const result = await requireServices(c).verificationService.addEvidence({
      skillId: c.req.param("skillId"),
      runId: c.req.param("runId"),
      result: parsed.data,
      principal: requirePrincipal(c),
      idempotencyKey: requireIdempotencyKey(c),
      requestId: c.get("requestId"),
      fencingEpoch: routingEpoch(c),
    });
    return c.json(success(c, result));
  });
  app.post("/api/v1/skills/:skillId/verification-runs/:runId/complete", async (c) => {
    const run = await requireServices(c).verificationService.complete({
      skillId: c.req.param("skillId"),
      runId: c.req.param("runId"),
      principal: requirePrincipal(c),
      idempotencyKey: requireIdempotencyKey(c),
      requestId: c.get("requestId"),
      fencingEpoch: routingEpoch(c),
    });
    return c.json(success(c, { run }));
  });
}
