import { DomainError } from "@skillplane/domain";
import type { AmendmentReviewDetail, AmendmentReviewStatus } from "@skillplane/domain";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import {
  readJsonObject,
  publicSkillVersion,
  requirePrincipal,
  requireIdempotencyKey,
} from "./shared.js";

function publicDetail(detail: AmendmentReviewDetail) {
  return {
    review: detail.review,
    candidate: publicSkillVersion(detail.candidate),
  };
}

function reviewStatus(value: string | undefined): AmendmentReviewStatus | "all" {
  const normalized = value ?? "all";
  if (!["all", "pending", "approved", "rejected", "superseded"].includes(normalized)) {
    throw new DomainError("VALIDATION_FAILED", "Review status is invalid", 400);
  }
  return normalized as AmendmentReviewStatus | "all";
}

export function registerReviewRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/skills/:skillId/candidates", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = requirePrincipal(context);
    const reviews = await services.amendmentReviewService.list({
      skillId: context.req.param("skillId"),
      principal,
      status: reviewStatus(context.req.query("status")),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { reviews: reviews.map(publicDetail) }));
  });

  app.get("/api/v1/skills/:skillId/candidates/:reviewId", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = requirePrincipal(context);
    const detail = await services.amendmentReviewService.get({
      skillId: context.req.param("skillId"),
      reviewId: context.req.param("reviewId"),
      principal,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, publicDetail(detail)));
  });

  for (const decision of ["approve", "reject"] as const) {
    app.post(
      `/api/v1/skills/:skillId/reviews/:reviewId/${decision}`,
      async (context) => {
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
        const detail = await services.amendmentReviewService[decision]({
          skillId: context.req.param("skillId"),
          reviewId: context.req.param("reviewId"),
          principal,
          reason: body.reason,
          idempotencyKey: requireIdempotencyKey(context),
          requestId: context.get("requestId"),
        });
        context.header("Cache-Control", "private, no-store");
        return context.json(success(context, publicDetail(detail)));
      },
    );
  }
}
