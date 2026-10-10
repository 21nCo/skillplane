import { DomainError } from "./errors.js";

export const WORKSPACE_KINDS = ["personal", "organization"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

export interface WorkspaceSummary {
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly slug: string;
  readonly name: string;
  readonly role: "viewer" | "editor" | "admin" | "owner";
  readonly updatedAt: string;
}

export function normalizeWorkspaceName(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", "Workspace name is required", 400);
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 120) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Workspace name must contain 1 to 120 characters",
      400,
      { field: "name" },
    );
  }
  return name;
}

export function normalizeWorkspaceSlug(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", "Workspace slug is required", 400);
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (slug.length < 2 || slug.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Workspace slug must contain 2 to 63 lowercase letters, numbers, or hyphens",
      400,
      { field: "slug" },
    );
  }
  return slug;
}

export function personalWorkspaceSlug(userId: string): string {
  const stable = userId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(-32);
  return `personal-${stable || "workspace"}`;
}
