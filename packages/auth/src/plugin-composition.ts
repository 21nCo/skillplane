import { authFnApiKeyPlugin } from "@authfn/api-keys";
import { authFnEmailOtpPlugin } from "@authfn/email-otp";
import { authFnMultiRegionPlugin } from "@authfn/multi-region";
import { authFnPlugins, type AuthFnPlugin } from "authfn";

export const SERVICE_PRINCIPAL_API_KEY_PREFIX = "spk";

export function skillplaneAuthPlugins<const TOAuth extends AuthFnPlugin>(
  oauthPlugin: TOAuth,
) {
  return authFnPlugins(
    authFnEmailOtpPlugin(),
    authFnApiKeyPlugin({
      secretPrefix: SERVICE_PRINCIPAL_API_KEY_PREFIX,
    }),
    oauthPlugin,
    authFnMultiRegionPlugin(),
  );
}
