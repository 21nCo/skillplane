import { resolveUserPrincipal } from "@skillplane/db";
import { AuthenticationRequiredError, type Principal } from "@skillplane/domain";
import type { Context } from "hono";
import type { ApiEnvironment } from "../context.js";

export function requestedWorkspaceId(
  context: Context<ApiEnvironment>,
): string | undefined {
  return (
    context.req.header("x-skillplane-routed-workspace-id") ??
    context.req.header("x-skillplane-workspace-id")
  );
}

export async function resolveWorkspaceRequestContext(
  context: Context<ApiEnvironment>,
): Promise<Principal> {
  const services = context.get("services");
  if (!services) {
    throw new AuthenticationRequiredError();
  }
  return resolveUserPrincipal(
    services.controlDatabase.pool,
    context.get("session"),
    requestedWorkspaceId(context),
  );
}
