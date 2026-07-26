import { DomainError } from "@skillplane/domain";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiEnvironment } from "./context.js";
import { failure } from "./envelopes.js";

export interface ApiErrorResponse {
  readonly status: ContentfulStatusCode;
  readonly body: ReturnType<typeof failure>;
}

export function toApiError(
  context: Context<ApiEnvironment>,
  error: unknown,
): ApiErrorResponse {
  if (error instanceof DomainError) {
    return {
      status: error.status,
      body: failure(context, error.code, error.message, error.details),
    };
  }
  console.error(
    JSON.stringify({
      event: "api.unhandled_error",
      requestId: context.get("requestId"),
      errorName: error instanceof Error ? error.name : "UnknownError",
    }),
  );
  return {
    status: 500,
    body: failure(context, "INTERNAL_ERROR", "The request could not be completed"),
  };
}
