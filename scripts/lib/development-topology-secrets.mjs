import {
  developmentSecrets,
  developmentPostHogProjectToken,
} from "./development-deployment.mjs";
import {
  requireEnvironment,
  requireSecretEnvironment,
} from "./production-deployment.mjs";
import { validateDatafnTicketKeys } from "./datafn-ticket-keys.mjs";

export function topologySecrets(output) {
  if (output.kind === "projection" || output.kind === "datafn") return null;
  const development = developmentSecrets();
  const shared = {
    OAUTH_TOKEN_PEPPER: development.OAUTH_TOKEN_PEPPER,
    WORKSPACE_ROUTING_KEYS: JSON.stringify({
      current: requireSecretEnvironment("SKILLPLANE_DEV_WORKSPACE_ROUTING_SECRET"),
    }),
  };
  const direct = output.config?.vars?.DATAFN_DIRECT_ENABLED === "true";
  const ticketKeys = direct
    ? validateDatafnTicketKeys({
        activeKeyId: requireEnvironment("DATAFN_ROUTE_ACTIVE_KEY_ID"),
        privateKey: requireSecretEnvironment("DATAFN_ROUTE_PRIVATE_KEY_PEM"),
        publicKeysJson: requireEnvironment("DATAFN_ROUTE_PUBLIC_KEYS"),
      })
    : null;
  if (output.id === "gateway:app") {
    return {
      AUTHFN_SECRET: development.AUTHFN_SECRET,
      TURNSTILE_SECRET_KEY: development.TURNSTILE_SECRET_KEY,
      ...shared,
      ...(direct
        ? {
            DATAFN_ROUTE_ACTIVE_KEY_ID: ticketKeys.activeKeyId,
            DATAFN_ROUTE_PRIVATE_KEY_PEM: ticketKeys.privateKey,
            AUTHFN_PLACEMENT_SUBJECT_SECRET: requireSecretEnvironment(
              "AUTHFN_PLACEMENT_SUBJECT_SECRET",
            ),
          }
        : {}),
    };
  }
  if (output.kind === "mcp") {
    return {
      ...shared,
      POSTHOG_PROJECT_TOKEN: developmentPostHogProjectToken(),
    };
  }
  return {
    ...shared,
    ...(direct ? { DATAFN_ROUTE_PUBLIC_KEYS: ticketKeys.publicKeysJson } : {}),
  };
}
