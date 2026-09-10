import {
  developmentSecrets,
  developmentPostHogProjectToken,
} from "./development-deployment.mjs";
import { requireSecretEnvironment } from "./production-deployment.mjs";

export function topologySecrets(output) {
  if (output.kind === "projection") return null;
  const development = developmentSecrets();
  const shared = {
    OAUTH_TOKEN_PEPPER: development.OAUTH_TOKEN_PEPPER,
    WORKSPACE_ROUTING_KEYS: JSON.stringify({
      current: requireSecretEnvironment("SKILLPLANE_DEV_WORKSPACE_ROUTING_SECRET"),
    }),
  };
  if (output.id === "gateway:app") {
    return {
      AUTHFN_SECRET: development.AUTHFN_SECRET,
      TURNSTILE_SECRET_KEY: development.TURNSTILE_SECRET_KEY,
      ...shared,
    };
  }
  if (output.kind === "mcp") {
    return {
      ...shared,
      POSTHOG_PROJECT_TOKEN: developmentPostHogProjectToken(),
    };
  }
  return shared;
}
