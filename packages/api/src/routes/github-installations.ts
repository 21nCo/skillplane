import { DomainError, GitHubInstallationService } from "@skillplane/domain";
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

function settingsRedirect(c: Context<ApiEnvironment>, query: Record<string, string>) {
  const target = `${GITHUB_SETTINGS_PATH}?${new URLSearchParams(query).toString()}`;
  // The callback URL carries the state and GitHub's code: never cache it or
  // pass it on as a referrer.
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(target, 302);
}

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
    // `truncated` is set when GitHub has more repositories than are listed.
    const listing = await service(c).repositories(
      await workspaceUser(c),
      c.req.param("installationId"),
    );
    c.header("Cache-Control", "private, no-store");
    return c.json(success(c, listing));
  });

  // GitHub returns the browser here after an install (the App's callback
  // URL). The workspace comes only from the signed state; every refusal
  // returns to settings with an error code instead of binding anything.
  const setup = async (c: Context<ApiEnvironment>) => {
    if (c.req.query("setup_action") === "request")
      return settingsRedirect(c, { github_error: "GITHUB_INSTALL_PENDING_APPROVAL" });
    const state = c.req.query("state") ?? null;
    try {
      const services = c.get("services");
      if (!services)
        throw new DomainError(
          "AUTHENTICATION_REQUIRED",
          "Authentication is required",
          401,
        );
      // Only a state this deployment signed names the workspace to act in.
      const { workspaceId } = await service(c).verifyInstallState(state);
      const principal = await requireUserPrincipal(
        services.controlDatabase.pool,
        c.get("session"),
        workspaceId,
      );
      const installation = await service(c).completeSetup({
        principal,
        requestId: c.get("requestId"),
        fencingEpoch: routingEpoch(c),
        state,
        installationId: c.req.query("installation_id"),
        code: c.req.query("code"),
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
  app.get("/github/setup", setup);
  app.get("/api/v1/github/setup", setup);
}
