import { DomainError, SkillGroupService, groupPage } from "@skillplane/domain";
import type { Hono, Context } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import {
  workspaceUser,
  optionalIdFilter,
  readJsonObject,
  requireIdempotencyKey,
  routingEpoch,
} from "./shared.js";
function services(c: Context<ApiEnvironment>) {
  const value = c.get("services");
  if (!value)
    throw new DomainError("AUTHENTICATION_REQUIRED", "Authentication is required", 401);
  return value;
}
export function registerSkillGroupRoutes(app: Hono<ApiEnvironment>) {
  const base = "/api/v1/workspaces/:workspaceId/groups";
  app.get(base, async (c) => {
    const principal = await workspaceUser(c),
      s = services(c);
    const state = c.req.query("state") ?? "active";
    if (state !== "active" && state !== "all")
      throw new DomainError(
        "VALIDATION_FAILED",
        "Group state must be active or all",
        400,
      );
    const page = groupPage(c.req.query("limit") ?? 50, c.req.query("cursor") ?? null);
    const data = await new SkillGroupService(
      s.database.pool,
      s.controlDatabase.pool,
    ).list(principal, {
      ...page,
      archived: state === "all",
      ...optionalIdFilter(c, "skillId"),
      ...optionalIdFilter(c, "userId"),
    });
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, data));
  });
  app.post(base, async (c) => {
    const principal = await workspaceUser(c),
      s = services(c),
      body = await readJsonObject(c);
    const group = await new SkillGroupService(
      s.database.pool,
      s.controlDatabase.pool,
    ).create({
      principal,
      name: body.name,
      description: body.description,
      idempotencyKey: requireIdempotencyKey(c),
      requestId: c.get("requestId"),
      fencingEpoch: routingEpoch(c),
    });
    return c.json(success(c, { group }), 201);
  });
  app.get(`${base}/:groupId`, async (c) => {
    const principal = await workspaceUser(c),
      s = services(c);
    const group = await new SkillGroupService(
      s.database.pool,
      s.controlDatabase.pool,
    ).get(principal, c.req.param("groupId"));
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, { group }));
  });
  app.patch(`${base}/:groupId`, async (c) => {
    const principal = await workspaceUser(c),
      s = services(c),
      body = await readJsonObject(c);
    if (typeof body.archived !== "boolean" || typeof body.expectedRevision !== "number")
      throw new DomainError(
        "VALIDATION_FAILED",
        "Revision and archived state are required",
        400,
      );
    const group = await new SkillGroupService(
      s.database.pool,
      s.controlDatabase.pool,
    ).update({
      principal,
      groupId: c.req.param("groupId"),
      expectedRevision: body.expectedRevision,
      name: body.name,
      description: body.description,
      archived: body.archived,
      requestId: c.get("requestId"),
      fencingEpoch: routingEpoch(c),
    });
    return c.json(success(c, { group }));
  });
  app.get(`${base}/:groupId/skills`, async (c) => {
    const principal = await workspaceUser(c),
      s = services(c);
    const data = await new SkillGroupService(
      s.database.pool,
      s.controlDatabase.pool,
    ).skills(
      principal,
      c.req.param("groupId"),
      groupPage(c.req.query("limit") ?? 20, c.req.query("cursor") ?? null),
    );
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, data));
  });
  app.get(`${base}/:groupId/members`, async (c) => {
    const principal = await workspaceUser(c),
      s = services(c);
    const data = await new SkillGroupService(
      s.database.pool,
      s.controlDatabase.pool,
    ).members(
      principal,
      c.req.param("groupId"),
      groupPage(c.req.query("limit") ?? 50, c.req.query("cursor") ?? null),
    );
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, data));
  });
  for (const kind of ["skills", "members"] as const)
    for (const method of ["put", "delete"] as const) {
      app[method](`${base}/:groupId/${kind}/:targetId`, async (c) => {
        const principal = await workspaceUser(c),
          s = services(c);
        const data = await new SkillGroupService(
          s.database.pool,
          s.controlDatabase.pool,
        ).association({
          principal,
          groupId: c.req.param("groupId"),
          kind: kind === "skills" ? "skill" : "member",
          targetId: c.req.param("targetId"),
          add: method === "put",
          requestId: c.get("requestId"),
          fencingEpoch: routingEpoch(c),
        });
        return c.json(success(c, data));
      });
    }
}
