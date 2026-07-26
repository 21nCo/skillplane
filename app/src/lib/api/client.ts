export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly requestId: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta: { readonly requestId: string };
}

interface ErrorEnvelope {
  readonly ok: false;
  readonly error: ApiErrorBody;
}

export class SkillplaneApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(status: number, body?: ApiErrorBody) {
    super(body?.message ?? "Skillplane could not complete the request");
    this.name = "SkillplaneApiError";
    this.status = status;
    this.code = body?.code ?? "REQUEST_FAILED";
    this.requestId = body?.requestId;
    this.details = body?.details;
  }
}

function csrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("skillplane.csrf="))
    ?.slice("skillplane.csrf=".length);
  return value ? decodeURIComponent(value) : undefined;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method)) {
    const csrf = csrfToken();
    if (csrf) headers.set("x-authfn-csrf", csrf);
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers,
    });
  } catch {
    throw new SkillplaneApiError(0, {
      code: "NETWORK_UNAVAILABLE",
      message: "Skillplane could not be reached. Check your connection and retry.",
      requestId: "",
    });
  }
  let envelope: SuccessEnvelope<T> | ErrorEnvelope;
  try {
    envelope = (await response.json()) as SuccessEnvelope<T> | ErrorEnvelope;
  } catch {
    throw new SkillplaneApiError(response.status);
  }
  if (!response.ok || !envelope.ok) {
    throw new SkillplaneApiError(
      response.status,
      envelope.ok ? undefined : envelope.error,
    );
  }
  return envelope.data;
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
