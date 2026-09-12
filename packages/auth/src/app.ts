import type { AuthFnServer } from "authfn";
import { Hono } from "hono";

export interface CreateAuthApplicationInput {
  readonly authfn: AuthFnServer;
}

interface AuthErrorBody {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly requestId: string;
}

function isAuthErrorBody(value: unknown): value is AuthErrorBody {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (!candidate.error || typeof candidate.error !== "object") return false;
  const error = candidate.error as Record<string, unknown>;
  return (
    candidate.ok === false &&
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean" &&
    (error.details === undefined ||
      (error.details !== null &&
        typeof error.details === "object" &&
        !Array.isArray(error.details))) &&
    typeof candidate.requestId === "string"
  );
}

async function safeAuthResponse(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!isAuthErrorBody(body)) return response;

  const headers = new Headers(response.headers);
  const retryAfterSeconds = body.error.details?.retryAfterSeconds;
  if (
    body.error.code === "AUTHFN_RATE_LIMITED" &&
    typeof retryAfterSeconds === "number" &&
    Number.isFinite(retryAfterSeconds)
  ) {
    headers.set("retry-after", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  }

  const hidesChallengeState = [
    "AUTHFN_OTP_EXPIRED",
    "AUTHFN_OTP_INVALID",
    "AUTHFN_OTP_REPLAYED",
  ].includes(body.error.code);
  if (!hidesChallengeState) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return Response.json(
    {
      ...body,
      error: {
        code: body.error.code,
        message: body.error.message,
        retryable: body.error.retryable,
      },
    },
    { status: response.status, headers },
  );
}

/** Bridges AuthFn's released router to Hono without redeclaring its routes. */
export function createAuthApplication(input: CreateAuthApplicationInput) {
  const app = new Hono();
  app.all("/auth/*", async (context) => {
    const request = context.req.raw;
    if (!input.authfn.router.match(request.method, new URL(request.url).pathname)) {
      const incomingRequestId = request.headers.get("x-request-id")?.trim();
      const requestId = incomingRequestId?.length
        ? incomingRequestId
        : `req_${crypto.randomUUID()}`;
      return Response.json(
        {
          ok: false,
          error: {
            code: "ROUTE_NOT_FOUND",
            message: "The requested authentication route does not exist",
            retryable: false,
          },
          requestId,
        },
        {
          status: 404,
          headers: {
            "cache-control": "private, no-store",
            "x-request-id": requestId,
          },
        },
      );
    }
    return safeAuthResponse(await input.authfn.router.handle(request));
  });
  return app;
}
