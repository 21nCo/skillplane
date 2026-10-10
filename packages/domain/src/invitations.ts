import { DomainError } from "./errors.js";
import { parseWorkspaceRole } from "./memberships.js";
import type { WorkspaceRole } from "./principal.js";

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function normalizeInvitationEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", "A valid email is required", 400);
  }
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    /[\r\n<>]/.test(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new DomainError("VALIDATION_FAILED", "A valid email is required", 400, {
      field: "email",
    });
  }
  return email;
}

export function parseInvitationRole(value: unknown): Exclude<WorkspaceRole, "owner"> {
  return parseWorkspaceRole(value) as Exclude<WorkspaceRole, "owner">;
}

export function invitationExpiry(now = new Date()): Date {
  return new Date(now.getTime() + INVITATION_TTL_SECONDS * 1000);
}

export function assertInvitationAcceptable(input: {
  readonly acceptedAt: Date | null;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly emailMatches: boolean;
  readonly now?: Date;
}): void {
  const now = input.now ?? new Date();
  if (input.acceptedAt) {
    throw new DomainError("INVITATION_USED", "This invitation was already used", 409);
  }
  if (input.revokedAt) {
    throw new DomainError(
      "INVITATION_REVOKED",
      "This invitation is no longer available",
      409,
    );
  }
  if (input.expiresAt.getTime() <= now.getTime()) {
    throw new DomainError("INVITATION_EXPIRED", "This invitation has expired", 409);
  }
  if (!input.emailMatches) {
    throw new DomainError(
      "INVITATION_EMAIL_MISMATCH",
      "Sign in with the invited email address",
      403,
    );
  }
}
