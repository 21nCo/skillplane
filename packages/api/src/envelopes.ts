import type { Context } from "hono";
import type { ApiEnvironment } from "./context.js";

export interface ApiMeta {
  readonly requestId: string;
}

export interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta: ApiMeta;
}

export interface ErrorEnvelope {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export function success<T>(
  context: Context<ApiEnvironment>,
  data: T,
): SuccessEnvelope<T> {
  return {
    ok: true,
    data,
    meta: { requestId: context.get("requestId") },
  };
}

export function failure(
  context: Context<ApiEnvironment>,
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ErrorEnvelope {
  return {
    ok: false,
    error: {
      code,
      message,
      requestId: context.get("requestId"),
      ...(details ? { details } : {}),
    },
  };
}
