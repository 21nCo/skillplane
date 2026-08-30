import { DomainError, parseSemanticBump } from "@skillplane/domain";
import { skillFileResponse } from "@skillplane/storage";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import { registerResourceRoutes } from "../resource-routing.js";
import {
  parseStringField,
  publicSkillVersion,
  readBundleUpload,
  readJsonObject,
  requireIdempotencyKey,
  requirePrincipal,
  routingEpoch,
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

export function registerSkillVersionRoutes(app: Hono<ApiEnvironment>): void {
  app.post("/api/v1/skills/:skillId/versions", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = requirePrincipal(context);
    const upload = await readBundleUpload(context);
    const version = await services.skillVersionService.createCandidate({
      skillId: context.req.param("skillId"),
      principal,
      baseVersionId: parseStringField(upload.fields.baseVersionId, "baseVersionId"),
      proposedBump: parseSemanticBump(upload.fields.proposedBump),
      changeSummary: parseStringField(upload.fields.changeSummary, "changeSummary", {
        maxLength: 2_000,
      }),
      archiveBytes: upload.archiveBytes,
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
      fencingEpoch: routingEpoch(context),
    });
    await registerResourceRoutes(services, principal.workspaceId, [
      { resourceType: "skill_version", resourceId: version.id },
    ]);
    context.header("Cache-Control", "private, no-store");
    return context.json(
      success(context, { version: publicSkillVersion(version) }),
      201,
    );
  });

  app.get("/api/v1/skills/:skillId/versions", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    }
    const limit = parseLimit(context.req.query("limit"));
    const versions = await services.skillVersionService.list({
      skillId: context.req.param("skillId"),
      principal: context.get("principal"),
      ...(limit !== undefined ? { limit } : {}),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(
      success(context, { versions: versions.map(publicSkillVersion) }),
    );
  });

  app.get("/api/v1/skills/:skillId/versions/:versionId/bundle", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "SKILL_VERSION_NOT_FOUND",
        "Skill version was not found",
        404,
      );
    }
    const bundle = await services.skillVersionService.retrieveBundle({
      skillId: context.req.param("skillId"),
      versionId: context.req.param("versionId"),
      principal: context.get("principal"),
      allowArchived: Boolean(context.get("principal")),
    });
    context.header("Cache-Control", "private, no-store");
    context.header("Content-Type", "application/zip");
    context.header(
      "Content-Disposition",
      `attachment; filename="skill-${context.req
        .param("versionId")
        .replaceAll(/[^a-zA-Z0-9._-]/gu, "-")}.zip"`,
    );
    context.header("ETag", `"${bundle.digest}"`);
    const body = new Uint8Array(bundle.bytes.byteLength);
    body.set(bundle.bytes);
    return context.body(body.buffer);
  });

  app.get(
    "/api/v1/skills/:skillId/versions/:versionId/files/:path{.+}",
    async (context) => {
      const services = context.get("services");
      if (!services) {
        throw new DomainError("SKILL_FILE_NOT_FOUND", "Skill file was not found", 404);
      }
      const path = context.req.param("path");
      if (!path) {
        throw new DomainError("SKILL_FILE_NOT_FOUND", "Skill file was not found", 404);
      }
      const retrieved = await services.skillVersionService.retrieveFile({
        skillId: context.req.param("skillId"),
        versionId: context.req.param("versionId"),
        path,
        principal: context.get("principal"),
        allowArchived: Boolean(context.get("principal")),
      });
      const ifNoneMatch = context.req.header("if-none-match");
      // The route is access-controlled and skill visibility is revocable, so a URL
      // without the content digest is never shared-cacheable.
      return skillFileResponse(retrieved.file, {
        publicImmutable: false,
        ...(ifNoneMatch ? { ifNoneMatch } : {}),
        download: context.req.query("download") === "true",
      });
    },
  );

  app.get("/api/v1/skills/:skillId/versions/:versionId", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "SKILL_VERSION_NOT_FOUND",
        "Skill version was not found",
        404,
      );
    }
    const version = await services.skillVersionService.get({
      skillId: context.req.param("skillId"),
      versionId: context.req.param("versionId"),
      principal: context.get("principal"),
      allowArchived: Boolean(context.get("principal")),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { version: publicSkillVersion(version) }));
  });

  app.get("/api/v1/skills/:skillId/diff", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const diff = await services.skillVersionService.diff({
      skillId: context.req.param("skillId"),
      fromVersionId: parseStringField(context.req.query("from"), "from"),
      toVersionId: parseStringField(context.req.query("to"), "to"),
      principal: requirePrincipal(context),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { diff }));
  });

  app.post("/api/v1/skills/:skillId/candidates/:versionId/approve", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const version = await services.publicationService.publish({
      skillId: context.req.param("skillId"),
      candidateVersionId: context.req.param("versionId"),
      principal: requirePrincipal(context),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
      fencingEpoch: routingEpoch(context),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { version: publicSkillVersion(version) }));
  });

  app.post("/api/v1/skills/:skillId/candidates/:versionId/reject", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const body = await readJsonObject(context);
    const version = await services.publicationService.reject({
      skillId: context.req.param("skillId"),
      candidateVersionId: context.req.param("versionId"),
      principal: requirePrincipal(context),
      reason: parseStringField(body.reason, "reason", { maxLength: 2_000 }),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { version: publicSkillVersion(version) }));
  });
}
