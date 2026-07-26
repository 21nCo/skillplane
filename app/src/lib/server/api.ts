import { env as privateEnvironment } from "$env/dynamic/private";
import { createApiApp, createApiServiceProvider } from "@skillplane/api";
import type { RuntimeBindings } from "@skillplane/config";

export const api = createApiApp({
  serviceName: "skillplane-app",
  getServices: createApiServiceProvider(),
});

export function runtimeBindings(platform: App.Platform | undefined): RuntimeBindings {
  return {
    ...privateEnvironment,
    ...(platform?.env ?? {}),
  };
}
