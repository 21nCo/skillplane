import {
  DomainError,
  parseContextArchiveFilter,
  parseContextType,
  type ContextType,
} from "@skillplane/domain";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import { registerResourceRoutes } from "../resource-routing.js";
import { readJsonObject, requireIdempotencyKey, requirePrincipal } from "./shared.js";

function objectField(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a JSON object`, 400, {
      field,
    });
  }
  return value as Readonly<Record<string, unknown>>;
}

function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "expectedRevision must be a non-negative integer",
      400,
      { field: "expectedRevision" },
    );
  }
  return Number(value);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a string`, 400, {
      field,
    });
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${field} must be a string or null`,
      400,
      { field },
    );
  }
  return value;
}

export function registerContextRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/skills/:skillId/contexts", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const contexts = await services.contextService.list({
      skillId: context.req.param("skillId"),
      principal: requirePrincipal(context),
      archive: parseContextArchiveFilter(context.req.query("state") ?? "active"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { contexts }));
  });

  app.post("/api/v1/skills/:skillId/contexts", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const body = await readJsonObject(context);
    const externalReference = nullableString(
      body.externalReference,
      "externalReference",
    );
    const description = optionalString(body.description, "description");
    const metadata = objectField(body.metadata, "metadata");
    const learningMetadata = objectField(body.learningMetadata, "learningMetadata");
    const created = await services.contextService.create({
      skillId: context.req.param("skillId"),
      principal: requirePrincipal(context),
      slug: typeof body.slug === "string" ? body.slug : "",
      name: typeof body.name === "string" ? body.name : "",
      type: parseContextType(body.type),
      ...(externalReference !== undefined ? { externalReference } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      initialKnowledge: typeof body.knowledge === "string" ? body.knowledge : "",
      ...(learningMetadata !== undefined ? { learningMetadata } : {}),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    await registerResourceRoutes(services, requirePrincipal(context).workspaceId, [
      { resourceType: "context", resourceId: created.context.id },
    ]);
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, created), 201);
  });

  app.get("/api/v1/skills/:skillId/contexts/by-slug/:contextSlug", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const resource = await services.contextService.getBySlug({
      skillId: context.req.param("skillId"),
      contextSlug: context.req.param("contextSlug"),
      principal: requirePrincipal(context),
      allowArchived: true,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { context: resource }));
  });

  app.get("/api/v1/contexts/:contextId/knowledge/history", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
    }
    const revisions = await services.contextKnowledgeService.history({
      contextId: context.req.param("contextId"),
      principal: requirePrincipal(context),
      allowArchived: true,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { revisions }));
  });

  app.get("/api/v1/contexts/:contextId/knowledge", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
    }
    const knowledge = await services.contextKnowledgeService.getCurrent({
      contextId: context.req.param("contextId"),
      principal: requirePrincipal(context),
      allowArchived: true,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { knowledge }));
  });

  app.put("/api/v1/contexts/:contextId/knowledge", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const body = await readJsonObject(context);
    const learningMetadata = objectField(body.learningMetadata, "learningMetadata");
    const knowledge = await services.contextKnowledgeService.update({
      contextId: context.req.param("contextId"),
      principal: requirePrincipal(context),
      expectedRevision: expectedRevision(body.expectedRevision),
      body: typeof body.knowledge === "string" ? body.knowledge : "",
      ...(learningMetadata !== undefined ? { learningMetadata } : {}),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { knowledge }));
  });

  app.get("/api/v1/contexts/:contextId/notes", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
    }
    const notes = await services.contextNoteService.list({
      contextId: context.req.param("contextId"),
      principal: requirePrincipal(context),
      archive: parseContextArchiveFilter(context.req.query("state") ?? "active"),
      allowArchivedContext: true,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { notes }));
  });

  app.post("/api/v1/contexts/:contextId/notes", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const body = await readJsonObject(context);
    const learningMetadata = objectField(body.learningMetadata, "learningMetadata");
    const note = await services.contextNoteService.create({
      contextId: context.req.param("contextId"),
      principal: requirePrincipal(context),
      title: typeof body.title === "string" ? body.title : "",
      body: typeof body.body === "string" ? body.body : "",
      ...(learningMetadata !== undefined ? { learningMetadata } : {}),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    await registerResourceRoutes(services, requirePrincipal(context).workspaceId, [
      { resourceType: "context_note", resourceId: note.id },
    ]);
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { note }), 201);
  });

  app.get("/api/v1/contexts/:contextId", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
    }
    const resource = await services.contextService.get({
      contextId: context.req.param("contextId"),
      principal: requirePrincipal(context),
      allowArchived: true,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { context: resource }));
  });

  app.patch("/api/v1/contexts/:contextId", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const body = await readJsonObject(context);
    const allowed = new Set([
      "name",
      "type",
      "externalReference",
      "description",
      "metadata",
    ]);
    if (Object.keys(body).some((field) => !allowed.has(field))) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Only context metadata fields can be changed",
        400,
      );
    }
    const patch: {
      name?: string;
      type?: ContextType;
      externalReference?: string | null;
      description?: string;
      metadata?: Readonly<Record<string, unknown>>;
    } = {};
    if ("name" in body) patch.name = optionalString(body.name, "name") ?? "";
    if ("type" in body) patch.type = parseContextType(body.type);
    if ("externalReference" in body) {
      patch.externalReference =
        nullableString(body.externalReference, "externalReference") ?? null;
    }
    if ("description" in body) {
      patch.description = optionalString(body.description, "description") ?? "";
    }
    if ("metadata" in body) {
      patch.metadata = objectField(body.metadata, "metadata") ?? {};
    }
    const resource = await services.contextService.update({
      contextId: context.req.param("contextId"),
      principal: requirePrincipal(context),
      patch,
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { context: resource }));
  });

  for (const archived of [true, false] as const) {
    app.post(
      `/api/v1/contexts/:contextId/${archived ? "archive" : "restore"}`,
      async (context) => {
        const services = context.get("services");
        if (!services) {
          throw new DomainError(
            "AUTHENTICATION_REQUIRED",
            "Authentication is required",
            401,
          );
        }
        const resource = await services.contextService.setArchived({
          contextId: context.req.param("contextId"),
          principal: requirePrincipal(context),
          archived,
          idempotencyKey: requireIdempotencyKey(context),
          requestId: context.get("requestId"),
        });
        context.header("Cache-Control", "private, no-store");
        return context.json(success(context, { context: resource }));
      },
    );
  }
}
