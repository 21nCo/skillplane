import {
  DomainError,
  parseSkillArchiveFilter,
  parseSkillVisibility,
} from "@skillplane/domain";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "limit must be an integer between 1 and 100",
      400,
      { field: "limit" },
    );
  }
  return parsed;
}

export function registerSkillSearchRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/skills/search", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Skill search is unavailable",
        503,
      );
    }
    const repeatedTags = context.req.queries("tag") ?? [];
    const commaTags =
      context.req
        .query("tags")
        ?.split(",")
        .map((tag) => tag.trim())
        .filter(Boolean) ?? [];
    const limit = parseLimit(context.req.query("limit"));
    const visibility = [
      ...(context.req.queries("visibility") ?? []),
      ...(context.req
        .query("visibilities")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean) ?? []),
    ].map(parseSkillVisibility);
    const archive = parseSkillArchiveFilter(context.req.query("state") ?? "active");
    if (services.publicProjectionService && !context.req.query("workspaceId")) {
      if (visibility.some((value) => value !== "public")) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Global skill search supports only public visibility",
          400,
          { field: "visibility" },
        );
      }
      if (archive !== "active") {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Global skill search supports only active skills",
          400,
          { field: "state" },
        );
      }
      const page = await services.publicProjectionService.discover({
        query: context.req.query("q") ?? "",
        tags: [...repeatedTags, ...commaTags],
        ...(limit !== undefined ? { limit } : {}),
        cursor: context.req.query("cursor") ?? null,
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(success(context, page));
    }
    const page = await services.skillSearchService.search({
      query: context.req.query("q") ?? "",
      tags: [...repeatedTags, ...commaTags],
      visibility,
      archive,
      ...(limit !== undefined ? { limit } : {}),
      cursor: context.req.query("cursor") ?? null,
      principal: context.get("principal"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, page));
  });
}
