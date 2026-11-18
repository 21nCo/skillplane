import { apiRequest } from "$lib/api/client.js";

export type GitHubInstallationStatus = "active" | "suspended" | "removed";

export interface GitHubInstallation {
  readonly installationId: number;
  readonly accountLogin: string;
  readonly accountType: string;
  readonly repositorySelection: "all" | "selected";
  readonly status: GitHubInstallationStatus;
  readonly suspendedAt: string | null;
  readonly removedAt: string | null;
  readonly checkedAt: string;
  readonly createdAt: string;
}

export interface GitHubRepository {
  readonly fullName: string;
  readonly private: boolean;
  readonly defaultBranch: string | null;
  readonly url: string;
}

function base(workspaceId: string) {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/github`;
}

/** Top-level navigation target that starts a GitHub App install. */
export function githubInstallHref(workspaceId: string) {
  return `${base(workspaceId)}/install`;
}

export function listGitHubInstallations(workspaceId: string) {
  return apiRequest<{ installable: boolean; installations: GitHubInstallation[] }>(
    `${base(workspaceId)}/installations`,
    { headers: { "x-skillplane-workspace-id": workspaceId } },
  );
}

export function unbindGitHubInstallation(workspaceId: string, installationId: number) {
  return apiRequest<{ sourcesMarked: number }>(
    `${base(workspaceId)}/installations/${String(installationId)}`,
    { method: "DELETE", headers: { "x-skillplane-workspace-id": workspaceId } },
  );
}

export function listGitHubRepositories(workspaceId: string, installationId: number) {
  return apiRequest<{ repositories: GitHubRepository[] }>(
    `${base(workspaceId)}/installations/${String(installationId)}/repositories`,
    { headers: { "x-skillplane-workspace-id": workspaceId } },
  );
}

const SETUP_ERRORS: Readonly<Record<string, string>> = {
  GITHUB_INSTALL_STATE_INVALID:
    "The GitHub install link was invalid or expired. Connect GitHub again.",
  GITHUB_INSTALL_STATE_REPLAYED:
    "That GitHub install link was already used. Connect GitHub again.",
  GITHUB_INSTALLATION_NOT_ACCESSIBLE:
    "GitHub did not confirm that you can access this installation.",
  GITHUB_INSTALLATION_BOUND_ELSEWHERE:
    "This GitHub installation is already connected to another workspace.",
  GITHUB_INSTALL_PENDING_APPROVAL:
    "An owner of the GitHub account must approve the installation request first.",
  GITHUB_APP_NOT_CONFIGURED: "The GitHub App is not configured for this deployment.",
  WORKSPACE_FORBIDDEN: "Only workspace owners and admins can connect GitHub.",
  FORBIDDEN: "Only workspace owners and admins can connect GitHub.",
  AUTHENTICATION_REQUIRED: "Sign in again, then connect GitHub.",
};

/** A readable message for the error code the install callback returns. */
export function githubSetupErrorMessage(code: string): string {
  return SETUP_ERRORS[code] ?? "GitHub could not be connected. Try again.";
}
