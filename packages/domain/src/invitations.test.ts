import { describe, expect, it } from "vitest";
import {
  assertInvitationAcceptable,
  invitationExpiry,
  normalizeInvitationEmail,
} from "./invitations.js";

describe("invitations", () => {
  it("normalizes recipients and creates a bounded expiry", () => {
    const now = new Date("2026-07-25T06:00:00.000Z");
    expect(normalizeInvitationEmail(" Member@Example.TEST ")).toBe(
      "member@example.test",
    );
    expect(invitationExpiry(now).toISOString()).toBe("2026-08-01T06:00:00.000Z");
  });

  it("rejects terminal and mismatched acceptance states", () => {
    const future = new Date("2026-08-01T06:00:00.000Z");
    const now = new Date("2026-07-25T06:00:00.000Z");
    expect(() =>
      assertInvitationAcceptable({
        acceptedAt: null,
        expiresAt: future,
        revokedAt: null,
        emailMatches: true,
        now,
      }),
    ).not.toThrow();
    expect(() =>
      assertInvitationAcceptable({
        acceptedAt: now,
        expiresAt: future,
        revokedAt: null,
        emailMatches: true,
        now,
      }),
    ).toThrow("already used");
    expect(() =>
      assertInvitationAcceptable({
        acceptedAt: null,
        expiresAt: future,
        revokedAt: null,
        emailMatches: false,
        now,
      }),
    ).toThrow("invited email");
  });
});
