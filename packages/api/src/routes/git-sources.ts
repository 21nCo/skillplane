import { registerResourceRoutes } from "../resource-routing.js";
import { DomainError, GitSourceService } from "@skillplane/domain";
import type { Hono, Context } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import {
  workspaceUser,
  readJsonObject,
  requireIdempotencyKey,
  routingEpoch,
} from "./shared.js";
function service(c: Context<ApiEnvironment>) {
  const s = c.get("services");
  if (!s)
    throw new DomainError("AUTHENTICATION_REQUIRED", "Authentication is required", 401);
  return new GitSourceService(s.database.pool, s.skillService, s.skillVersionService);
}
export function registerGitSourceRoutes(app: Hono<ApiEnvironment>) {
  const base = "/api/v1/workspaces/:workspaceId/sources";
  const mutation = async (c: Context<ApiEnvironment>) => ({
    principal: await workspaceUser(c),
    requestId: c.get("requestId"),
    fencingEpoch: routingEpoch(c),
  });
  app.get(base, async (c) => {
    const data = await service(c).list(
      await workspaceUser(c),
      c.req.query("cursor") ?? null,
    );
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, data));
  });
  app.post(base, async (c) => {
    const m = await mutation(c),
      config = await readJsonObject(c);
    const source = await service(c).create({
      ...m,
      config,
      idempotencyKey: requireIdempotencyKey(c),
    });
    return c.json(success(c, { source }), 201);
  });
  app.get(`${base}/:sourceId`, async (c) => {
    const data = await service(c).get(await workspaceUser(c), c.req.param("sourceId"));
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, data));
  });
  app.patch(`${base}/:sourceId`, async (c) => {
    const m = await mutation(c),
      body = await readJsonObject(c);
    if (typeof body.expectedRevision !== "number" || typeof body.archived !== "boolean")
      throw new DomainError(
        "VALIDATION_FAILED",
        "Revision and archived state are required",
        400,
      );
    const source = await service(c).update({
      ...m,
      sourceId: c.req.param("sourceId"),
      expectedRevision: body.expectedRevision,
      archived: body.archived,
      config: body,
    });
    return c.json(success(c, { source }));
  });
  app.post(`${base}/:sourceId/bindings`, async (c) => {
    const m = await mutation(c),
      body = await readJsonObject(c);
    if (typeof body.path !== "string" || typeof body.skillId !== "string")
      throw new DomainError("VALIDATION_FAILED", "Path and skill ID are required", 400);
    return c.json(
      success(
        c,
        await service(c).bind({
          ...m,
          sourceId: c.req.param("sourceId"),
          path: body.path,
          skillId: body.skillId,
        }),
      ),
    );
  });
  app.delete(`${base}/:sourceId/bindings`, async (c) => {
    const m = await mutation(c),
      body = await readJsonObject(c);
    if (typeof body.path !== "string")
      throw new DomainError("VALIDATION_FAILED", "Binding path is required", 400);
    return c.json(
      success(
        c,
        await service(c).disconnect({
          ...m,
          sourceId: c.req.param("sourceId"),
          path: body.path,
        }),
      ),
    );
  });
  app.post(`${base}/:sourceId/preview`, async (c) =>
    c.json(
      success(
        c,
        await service(c).preview({
          ...(await mutation(c)),
          sourceId: c.req.param("sourceId"),
        }),
      ),
    ),
  );
  app.post(`${base}/:sourceId/apply`, async (c) => {
    const m = await mutation(c),
      body = await readJsonObject(c);
    if (typeof body.runId !== "string")
      throw new DomainError("VALIDATION_FAILED", "Confirm a preview run ID", 400);
    const result = await service(c).apply({
      ...m,
      sourceId: c.req.param("sourceId"),
      runId: body.runId,
    });
    const resources = result.results.flatMap((r) => [
      ...(r.skillId ? [{ resourceType: "skill" as const, resourceId: r.skillId }] : []),
      ...(r.versionId
        ? [{ resourceType: "skill_version" as const, resourceId: r.versionId }]
        : []),
    ]);
    const services = c.get("services");
    if (services)
      await registerResourceRoutes(services, m.principal.workspaceId, resources);
    return c.json(success(c, result));
  });
  app.get(
    "/api/v1/workspaces/:workspaceId/skills/:skillId/versions/:versionId/source",
    async (c) => {
      const s = c.get("services");
      if (!s)
        throw new DomainError(
          "AUTHENTICATION_REQUIRED",
          "Authentication is required",
          401,
        );
      const p = await workspaceUser(c);
      const version = await s.skillVersionService.get({
        skillId: c.req.param("skillId"),
        versionId: c.req.param("versionId"),
        principal: p,
        allowArchived: true,
      });
      if (version.skillId !== c.req.param("skillId"))
        throw new DomainError("NOT_FOUND", "Version was not found", 404);
      c.header("Cache-Control", "private, no-store");
      return c.json(
        success(c, { provenance: await service(c).provenance(p, version.id) }),
      );
    },
  );
}
