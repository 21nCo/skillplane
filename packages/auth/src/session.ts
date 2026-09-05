import type { AuthFnCookieConfig } from "authfn";

export const AUTH_COOKIE_PREFIX = "skillplane";
export const AUTH_SESSION_COOKIE = `__Secure-${AUTH_COOKIE_PREFIX}.session`;
export const AUTH_CSRF_COOKIE = `${AUTH_COOKIE_PREFIX}.csrf`;
export const AUTH_CSRF_HEADER = "x-authfn-csrf";

export const AUTH_COOKIE_CONFIG = {
  prefix: AUTH_COOKIE_PREFIX,
  path: "/",
  secure: true,
  sameSite: "lax",
  sessionMaxAgeSeconds: 60 * 60 * 24 * 7,
  csrfMaxAgeSeconds: 60 * 60 * 24 * 7,
} as const satisfies AuthFnCookieConfig;

export function readCsrfToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== AUTH_CSRF_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }
  return null;
}
