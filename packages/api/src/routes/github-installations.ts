import {
  DomainError,
  GitHubInstallationService,
  githubInstallStateWorkspace,
} from "@skillplane/domain";
import type { Context, Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import { requireUserPrincipal } from "../tenancy.js";
import { routingEpoch, workspaceUser } from "./shared.js";

/** Where the install callback returns the browser. */
export const GITHUB_SETTINGS_PATH = "/settings/github";

function service(c: Context<ApiEnvironment>) {
  const s = c.get("services");
  if (!s)
    throw new DomainError("AUTHENTICATION_REQUIRED", "Authentication is required", 401);
  return new GitHubInstallationService(s.database.pool, {
    app: s.githubApp ?? null,
    settings: s.githubInstallSettings ?? null,
    stateSecret: s.tenancySecret,
  });
}

/** The App's callback URL and its API alias, matched on the raw path. */
export const GITHUB_SETUP_PATHS = new Set(["/github/setup", "/api/v1/github/setup"]);

export type GitHubSetupCallback =
  | { readonly kind: "pending" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "callback";
      readonly state: string;
      readonly workspaceId: string;
      readonly installationId: string | null;
      readonly code: string | null;
    };

/**
 * Reads an install callback the one way the gateway (to route it) and the
 * setup route (to act on it) both use. Null when the URL is not a setup path;
 * an encoded or otherwise ambiguous path, a repeated parameter or a state that
 * names no routable workspace is invalid.
 */
export function githubSetupCallback(url: URL): GitHubSetupCallback | null {
  let decoded = url.pathname;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    // An undecodable path is not a setup path.
  }
  if (!GITHUB_SETUP_PATHS.has(decoded)) return null;
  const params = url.searchParams;
  if (
    !GITHUB_SETUP_PATHS.has(url.pathname) ||
    ["state", "code", "installation_id", "setup_action"].some(
      (name) => params.getAll(name).length > 1,
    )
  )
    return { kind: "invalid" };
  if (params.get("setup_action") === "request") return { kind: "pending" };
  const state = params.get("state");
  const workspaceId = githubInstallStateWorkspace(state);
  // eslint-disable-next-line no-control-regex
  if (!state || !workspaceId || /[\u0000-\u001f]/u.test(workspaceId))
    return { kind: "invalid" };
  return {
    kind: "callback",
    state,
    workspaceId,
    installationId: params.get("installation_id"),
    code: params.get("code"),
  };
}

function settingsRedirect(c: Context<ApiEnvironment>, query: Record<string, string>) {
  const search = new URLSearchParams(query).toString();
  const target = search ? `${GITHUB_SETTINGS_PATH}?${search}` : GITHUB_SETTINGS_PATH;
  // The callback URL carries the state and GitHub's code: never cache it or
  // pass it on as a referrer.
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(target, 302);
}

const invalidCallback = (c: Context<ApiEnvironment>) =>
  settingsRedirect(c, { github_error: "GITHUB_INSTALL_STATE_INVALID" });

export function registerGitHubInstallationRoutes(app: Hono<ApiEnvironment>) {
  const base = "/api/v1/workspaces/:workspaceId/github";
  const mutation = async (c: Context<ApiEnvironment>) => ({
    principal: await workspaceUser(c),
    requestId: c.get("requestId"),
    fencingEpoch: routingEpoch(c),
  });

  app.get(`${base}/install`, async (c) => {
    const url = await service(c).installUrl(await workspaceUser(c));
    c.header("Cache-Control", "no-store");
    return c.redirect(url, 302);
  });

  app.get(`${base}/installations`, async (c) => {
    const s = service(c);
    const m = await mutation(c);
    const installations = await s.list(m);
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, { installable: s.installable, installations }));
  });

  app.delete(`${base}/installations/:installationId`, async (c) => {
    const result = await service(c).unbind({
      ...(await mutation(c)),
      installationId: c.req.param("installationId"),
    });
    return c.json(success(c, result));
  });

  app.get(`${base}/installations/:installationId/repositories`, async (c) => {
    // `nextCursor` (and `truncated`) is set when GitHub has more repositories;
    // passing it as `cursor` reads the next ones.
    const listing = await service(c).repositories(
      await workspaceUser(c),
      c.req.param("installationId"),
      c.req.query("cursor") ?? null,
    );
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, listing));
  });

  // GitHub returns the browser here after an install (the App's callback
  // URL). The workspace comes only from the signed state, which must name the
  // workspace this cell was routed for; every refusal returns to settings
  // with an error code instead of binding anything.
  const setup = async (c: Context<ApiEnvironment>) => {
    // A HEAD (which Hono answers with this GET handler) consumes nothing.
    if (c.req.method !== "GET") return settingsRedirect(c, {});
    const callback = githubSetupCallback(new URL(c.req.url));
    if (callback?.kind === "pending")
      return settingsRedirect(c, { github_error: "GITHUB_INSTALL_PENDING_APPROVAL" });
    try {
      const services = c.get("services");
      if (!services)
        throw new DomainError(
          "AUTHENTICATION_REQUIRED",
          "Authentication is required",
          401,
        );
      if (callback?.kind !== "callback") return invalidCallback(c);
      // Only a state this deployment signed names the workspace to act in,
      // and only the cell (or single deployment) holding it binds.
      const { workspaceId } = await service(c).verifyInstallState(callback.state);
      const routed = c.req.header("x-skillplane-routed-workspace-id");
      if (
        services.deploymentRole === "gateway" ||
        services.deploymentRole === "control" ||
        (services.deploymentRole === "cell" && routed !== workspaceId)
      )
        return invalidCallback(c);
      const principal = await requireUserPrincipal(
        services.controlDatabase.pool,
        c.get("session"),
        workspaceId,
      );
      const installation = await service(c).completeSetup({
        principal,
        requestId: c.get("requestId"),
        fencingEpoch: routingEpoch(c),
        state: callback.state,
        installationId: callback.installationId,
        code: callback.code,
      });
      return settingsRedirect(c, {
        github_connected: String(installation.installationId),
      });
    } catch (error) {
      return settingsRedirect(c, {
        github_error: error instanceof DomainError ? error.code : "SERVICE_UNAVAILABLE",
      });
    }
  };
  for (const path of GITHUB_SETUP_PATHS) app.get(path, setup);
}
