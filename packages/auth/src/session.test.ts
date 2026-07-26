import { describe, expect, it } from "vitest";
import {
  AUTH_COOKIE_CONFIG,
  AUTH_CSRF_COOKIE,
  AUTH_CSRF_HEADER,
  AUTH_SESSION_COOKIE,
  readCsrfToken,
} from "./session.js";

describe("AuthFn browser session policy", () => {
  it("uses secure HttpOnly-compatible session naming and scoped CSRF", () => {
    expect(AUTH_COOKIE_CONFIG).toMatchObject({
      path: "/",
      secure: true,
      sameSite: "lax",
    });
    expect(AUTH_SESSION_COOKIE).toBe("__Secure-skillplane.session");
    expect(AUTH_CSRF_COOKIE).toBe("skillplane.csrf");
    expect(AUTH_CSRF_HEADER).toBe("x-authfn-csrf");
    expect(readCsrfToken("other=x; skillplane.csrf=csrf%20token; final=y")).toBe(
      "csrf token",
    );
  });
});
