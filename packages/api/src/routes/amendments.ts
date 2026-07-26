import { DomainError } from "@skillplane/domain";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import {
  readJsonObject,
  publicSkillVersion,
  requirePrincipal,
  requireIdempotencyKey,
} from "./shared.js";

export function registerAmendmentRoutes(app: Hono<ApiEnvironment>): void {
  app.post("/api/v1/skills/:skillId/amendments", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = requirePrincipal(context);
    const body = await readJsonObject(context);
    const result = await services.amendmentService.amend({
      skillId: context.req.param("skillId"),
      principal,
      baseVersionId: typeof body.baseVersionId === "string" ? body.baseVersionId : "",
      proposedBump: body.proposedBump,
      changes: body.changes,
      learning: body.learning,
      caller: body.caller,
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(
      success(context, {
        ...result,
        candidate: publicSkillVersion(result.candidate),
      }),
      201,
    );
  });

  app.get("/api/v1/skills/:skillId/amendment-policy", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = requirePrincipal(context);
    const policy = await services.amendmentPolicyService.get({
      skillId: context.req.param("skillId"),
      principal,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { policy }));
  });

  app.put("/api/v1/skills/:skillId/amendment-policy", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = requirePrincipal(context);
    const body = await readJsonObject(context);
    const policy = await services.amendmentPolicyService.update({
      skillId: context.req.param("skillId"),
      principal,
      policy: body.policy,
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { policy }));
  });
}
