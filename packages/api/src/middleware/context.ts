import { resolveUserPrincipal } from "@skillplane/db";
import { AuthenticationRequiredError, type Principal } from "@skillplane/domain";
import type { Context } from "hono";
import type { ApiEnvironment } from "../context.js";

export async function resolveWorkspaceRequestContext(
  context: Context<ApiEnvironment>,
): Promise<Principal> {
  const services = context.get("services");
  if (!services) {
    throw new AuthenticationRequiredError();
  }
  return resolveUserPrincipal(
    services.database.pool,
    context.get("session"),
    context.req.header("x-skillplane-workspace-id"),
  );
}
