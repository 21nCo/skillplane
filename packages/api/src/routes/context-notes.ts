import { DomainError } from "@skillplane/domain";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
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
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new DomainError(
      "NOTE_REVISION_CONFLICT",
      "A positive expectedRevision is required to update a note",
      409,
      { field: "expectedRevision" },
    );
  }
  return Number(value);
}

export function registerContextNoteRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/context-notes/:noteId/history", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("NOTE_NOT_FOUND", "Context note was not found", 404);
    }
    const revisions = await services.contextNoteService.history({
      noteId: context.req.param("noteId"),
      principal: requirePrincipal(context),
      allowArchived: true,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { revisions }));
  });

  app.get("/api/v1/context-notes/:noteId", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError("NOTE_NOT_FOUND", "Context note was not found", 404);
    }
    const note = await services.contextNoteService.get({
      noteId: context.req.param("noteId"),
      principal: requirePrincipal(context),
      allowArchived: true,
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { note }));
  });

  app.put("/api/v1/context-notes/:noteId", async (context) => {
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
    const note = await services.contextNoteService.update({
      noteId: context.req.param("noteId"),
      principal: requirePrincipal(context),
      expectedRevision: expectedRevision(body.expectedRevision),
      title: typeof body.title === "string" ? body.title : "",
      body: typeof body.body === "string" ? body.body : "",
      ...(learningMetadata !== undefined ? { learningMetadata } : {}),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { note }));
  });

  app.post("/api/v1/context-notes/:noteId/archive", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const note = await services.contextNoteService.archive({
      noteId: context.req.param("noteId"),
      principal: requirePrincipal(context),
      idempotencyKey: requireIdempotencyKey(context),
      requestId: context.get("requestId"),
    });
    context.header("Cache-Control", "private, no-store");
    return context.json(success(context, { note }));
  });
}
