import {
  DomainError,
  parseSkillArchiveFilter,
  parseSkillVisibility,
  type SkillVisibility,
} from "@skillplane/domain";
import { skillFileResponse } from "@skillplane/storage";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import {
  publicSkillVersion,
  publicPublishedSkillVersion,
  readBundleUpload,
  readJsonObject,
  requireIdempotencyKey,
  workspacePrincipal,
} from "./shared.js";

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

function parseVisibilityFilter(context: {
  req: {
    queries(name: string): string[] | undefined;
    query(name: string): string | undefined;
  };
}): readonly SkillVisibility[] {
  const values = [
    ...(context.req.queries("visibility") ?? []),
    ...(context.req
      .query("visibilities")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []),
  ];
  return [...new Set(values.map(parseSkillVisibility))];
}

export function registerSkillRoutes(app: Hono<ApiEnvironment>): void {
  app.post("/api/v1/workspaces/:workspaceId/skills", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = await workspacePrincipal(context, "skills:write");
    const upload = await readBundleUpload(context);
    const created = await services.skillService.create({
      workspaceId: context.req.param("workspaceId"),
      principal,
      archiveBytes: upload.archiveBytes,
      visibility: parseSkillVisibility(upload.fields.visibility ?? "private"),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(
      success(context, {
        skill: created.skill,
        version: publicSkillVersion(created.version),
      }),
      201,
    );
  });

  app.get("/api/v1/workspaces/:workspaceId/skills", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = await workspacePrincipal(context, "skills:read");
    const legacyIncludeArchived = context.req.query("includeArchived");
    const archive =
      legacyIncludeArchived === "true"
        ? "all"
        : legacyIncludeArchived === "false" || legacyIncludeArchived === undefined
          ? parseSkillArchiveFilter(context.req.query("state") ?? "active")
          : (() => {
              throw new DomainError(
                "VALIDATION_FAILED",
                "includeArchived must be true or false",
                400,
                { field: "includeArchived" },
              );
            })();
    const limit = parseLimit(context.req.query("limit"));
    const query = context.req.query("q")?.trim() ?? "";
    const visibility = parseVisibilityFilter(context);
    if (query) {
      const page = await services.skillSearchService.search({
        query,
        principal,
        visibility,
        archive,
        ...(limit !== undefined ? { limit } : {}),
        cursor: context.req.query("cursor") ?? null,
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(
        success(context, {
          skills: page.skills.map((skill) => ({
            id: skill.id,
            workspaceId: skill.workspaceId,
            slug: skill.slug,
            name: skill.name,
            description: skill.description,
            tags: skill.tags,
            visibility: skill.visibility,
            currentPublishedVersionId: skill.currentVersionId,
            currentSemanticVersion: skill.semanticVersion,
            archivedAt: skill.archivedAt,
            createdAt: skill.createdAt,
            updatedAt: skill.updatedAt,
          })),
          nextCursor: page.nextCursor,
        }),
      );
    }
    const page = await services.skillService.listPage({
      workspaceId: context.req.param("workspaceId"),
      principal,
      archive,
      visibility,
      ...(limit !== undefined ? { limit } : {}),
      cursor: context.req.query("cursor") ?? null,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, page));
  });

  app.get(
    "/api/v1/workspaces/:workspaceId/skills/by-slug/:skillSlug",
    async (context) => {
      const services = context.get("services");
      if (!services) {
        throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
      }
      const principal = await workspacePrincipal(context, "skills:read");
      const skill = await services.skillService.getBySlug({
        workspaceId: context.req.param("workspaceId"),
        skillSlug: context.req.param("skillSlug"),
        principal,
        allowArchived: true,
      });
      context.header("Cache-Control", "private, no-store");
      return context.json(success(context, { skill }));
    },
  );

  app.get("/api/v1/skills/public", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "Public skill discovery is unavailable",
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
    const page = await services.skillSearchService.discoverPublic({
      query: context.req.query("q") ?? "",
      tags: [...repeatedTags, ...commaTags],
      ...(limit !== undefined ? { limit } : {}),
      cursor: context.req.query("cursor") ?? null,
    });
    context.header("Cache-Control", "public, max-age=0, must-revalidate");
    return context.json(success(context, page));
  });

  app.get(
    "/api/v1/skills/public/:workspaceSlug/:skillSlug/versions",
    async (context) => {
      const services = context.get("services");
      if (!services) {
        throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
      }
      const skill = await services.skillService.getPublicBySlug({
        workspaceSlug: context.req.param("workspaceSlug"),
        skillSlug: context.req.param("skillSlug"),
      });
      const limit = parseLimit(context.req.query("limit"));
      const versions = await services.skillVersionService.list({
        skillId: skill.id,
        ...(limit !== undefined ? { limit } : {}),
      });
      const etag = `"versions-${versions[0]?.digest ?? "empty"}-${versions.length.toString()}"`;
      context.header("Cache-Control", "public, max-age=0, must-revalidate");
      context.header("ETag", etag);
      if (context.req.header("if-none-match") === etag) {
        return context.body(null, 304);
      }
      return context.json(
        success(context, {
          versions: versions.map(publicPublishedSkillVersion),
        }),
      );
    },
  );

  app.get(
    "/api/v1/skills/public/:workspaceSlug/:skillSlug/versions/:versionId/:digest/files/:path{.+}",
    async (context) => {
      const services = context.get("services");
      if (!services) {
        throw new DomainError("SKILL_FILE_NOT_FOUND", "Skill file was not found", 404);
      }
      const path = context.req.param("path");
      const digest = context.req.param("digest");
      if (!path || !/^sha256:[a-f0-9]{64}$/u.test(digest)) {
        throw new DomainError("SKILL_FILE_NOT_FOUND", "Skill file was not found", 404);
      }
      const skill = await services.skillService.getPublicBySlug({
        workspaceSlug: context.req.param("workspaceSlug"),
        skillSlug: context.req.param("skillSlug"),
      });
      const version = await services.skillVersionService.get({
        skillId: skill.id,
        versionId: context.req.param("versionId"),
      });
      if (version.digest !== digest) {
        throw new DomainError("SKILL_FILE_NOT_FOUND", "Skill file was not found", 404);
      }
      const retrieved = await services.skillVersionService.retrieveFile({
        skillId: skill.id,
        versionId: version.id,
        path,
      });
      const ifNoneMatch = context.req.header("if-none-match");
      return skillFileResponse(retrieved.file, {
        publicImmutable: true,
        ...(ifNoneMatch ? { ifNoneMatch } : {}),
        download: context.req.query("download") === "true",
      });
    },
  );

  app.get("/api/v1/skills/public/:workspaceSlug/:skillSlug", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    }
    const skill = await services.skillService.getPublicBySlug({
      workspaceSlug: context.req.param("workspaceSlug"),
      skillSlug: context.req.param("skillSlug"),
    });
    if (!skill.currentPublishedVersionId) {
      throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    }
    const version = await services.skillVersionService.get({
      skillId: skill.id,
      versionId: skill.currentPublishedVersionId,
    });
    const etag = `"${version.digest}"`;
    context.header("Cache-Control", "public, max-age=0, must-revalidate");
    context.header("ETag", etag);
    if (context.req.header("if-none-match") === etag) {
      return context.body(null, 304);
    }
    return context.json(
      success(context, { skill, version: publicPublishedSkillVersion(version) }),
    );
  });

  app.get("/api/v1/skills/:skillId", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    }
    const skill = await services.skillService.get({
      skillId: context.req.param("skillId"),
      principal: context.get("principal"),
      allowArchived: Boolean(context.get("principal")),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { skill }));
  });

  app.patch("/api/v1/skills/:skillId", async (context) => {
    const services = context.get("services");
    const principal = context.get("principal");
    if (!services || !principal) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const body = await readJsonObject(context);
    if (
      body.visibility === undefined ||
      Object.keys(body).some((key) => key !== "visibility")
    ) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Only visibility can be changed by this endpoint",
        400,
      );
    }
    const skill = await services.skillService.setVisibility({
      skillId: context.req.param("skillId"),
      principal,
      visibility: parseSkillVisibility(body.visibility),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { skill }));
  });

  for (const archived of [true, false] as const) {
    app.post(
      `/api/v1/skills/:skillId/${archived ? "archive" : "restore"}`,
      async (context) => {
        const services = context.get("services");
        const principal = context.get("principal");
        if (!services || !principal) {
          throw new DomainError(
            "AUTHENTICATION_REQUIRED",
            "Authentication is required",
            401,
          );
        }
        const skill = await services.skillService.setArchived({
          skillId: context.req.param("skillId"),
          principal,
          archived,
          idempotencyKey: requireIdempotencyKey(context),
          requestId: context.get("requestId"),
        });
        context.header("Cache-Control", "private, no-store");
        return context.json(success(context, { skill }));
      },
    );
  }
}
