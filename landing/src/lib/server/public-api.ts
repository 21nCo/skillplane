import { env as privateEnvironment } from "$env/dynamic/private";
import type {
  PublicSkillDetail,
  PublicSkillPage,
  PublicSkillVersion,
} from "$lib/public-skills.js";

export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublicApiError";
  }
}

export function appOrigin(platform: App.Platform | undefined): string {
  const dynamicPrivateEnvironment = privateEnvironment as Partial<
    Record<string, string>
  >;
  const configured =
    process.env.SKILLPLANE_APP_ORIGIN ??
    platform?.env.SKILLPLANE_APP_ORIGIN ??
    dynamicPrivateEnvironment.SKILLPLANE_APP_ORIGIN ??
    __SKILLPLANE_BUILD_APP_ORIGIN__;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new PublicApiError(
      503,
      "PUBLIC_API_CONFIGURATION_INVALID",
      "Public skill discovery is not configured.",
    );
  }
  const local =
    ["localhost", "127.0.0.1"].includes(url.hostname) && url.protocol === "http:";
  if (url.protocol !== "https:" && !local) {
    throw new PublicApiError(
      503,
      "PUBLIC_API_CONFIGURATION_INVALID",
      "Public skill discovery is not configured.",
    );
  }
  return url.origin;
}

async function request<T>(
  fetcher: typeof fetch,
  origin: string,
  path: string,
  decode: (value: unknown) => T,
): Promise<{ readonly data: T; readonly response: Response }> {
  let response: Response;
  try {
    response = await fetcher(new URL(path, origin), {
      headers: { accept: "application/json" },
    });
  } catch {
    throw new PublicApiError(
      503,
      "PUBLIC_API_UNAVAILABLE",
      "Public skill discovery is temporarily unavailable.",
    );
  }
  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw new PublicApiError(
      502,
      "PUBLIC_API_INVALID_RESPONSE",
      "Public skill discovery returned an invalid response.",
    );
  }
  if (typeof envelope !== "object" || envelope === null) {
    throw new PublicApiError(
      502,
      "PUBLIC_API_INVALID_RESPONSE",
      "Public skill discovery returned an invalid response.",
    );
  }
  const record = envelope as Record<string, unknown>;
  if (!response.ok || record.ok !== true) {
    const error =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : {};
    const code = typeof error.code === "string" ? error.code : "PUBLIC_API_ERROR";
    const message =
      typeof error.message === "string"
        ? error.message
        : `Public skill discovery failed with status ${response.status.toString()}.`;
    throw new PublicApiError(response.status, code, message);
  }
  if (!("data" in record)) {
    throw new PublicApiError(
      502,
      "PUBLIC_API_INVALID_RESPONSE",
      "Public skill discovery returned an invalid response.",
    );
  }
  return { data: decode(record.data), response };
}

export function listPublicSkills(
  fetcher: typeof fetch,
  origin: string,
  query: URLSearchParams,
): Promise<{ readonly data: PublicSkillPage; readonly response: Response }> {
  return request<PublicSkillPage>(
    fetcher,
    origin,
    `/api/v1/skills/public?${query.toString()}`,
    (value) => value as PublicSkillPage,
  );
}

export function getPublicSkill(
  fetcher: typeof fetch,
  origin: string,
  workspaceSlug: string,
  skillSlug: string,
): Promise<{ readonly data: PublicSkillDetail; readonly response: Response }> {
  return request<PublicSkillDetail>(
    fetcher,
    origin,
    `/api/v1/skills/public/${encodeURIComponent(
      workspaceSlug,
    )}/${encodeURIComponent(skillSlug)}`,
    (value) => value as PublicSkillDetail,
  );
}

export function listPublicSkillVersions(
  fetcher: typeof fetch,
  origin: string,
  workspaceSlug: string,
  skillSlug: string,
): Promise<{
  readonly data: { readonly versions: readonly PublicSkillVersion[] };
  readonly response: Response;
}> {
  return request<{ readonly versions: readonly PublicSkillVersion[] }>(
    fetcher,
    origin,
    `/api/v1/skills/public/${encodeURIComponent(
      workspaceSlug,
    )}/${encodeURIComponent(skillSlug)}/versions?limit=100`,
    (value) => value as { readonly versions: readonly PublicSkillVersion[] },
  );
}
