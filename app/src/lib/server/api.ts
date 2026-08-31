import { env as privateEnvironment } from "$env/dynamic/private";
import {
  createApiApp,
  createApiServiceProvider,
  createRoutedApiApplication,
} from "@skillplane/api";
import type { RuntimeBindings } from "@skillplane/config";

const fullServices = createApiServiceProvider();
const cellServices = createApiServiceProvider({ authentication: "oauth-only" });
const services = Object.assign(
  (bindings: RuntimeBindings) =>
    bindings.SKILLPLANE_ROLE === "cell"
      ? cellServices(bindings)
      : fullServices(bindings),
  { release: () => Promise.resolve() },
);
const localApi = createApiApp({
  serviceName: "skillplane-app",
  getServices: services,
});

export const api = createRoutedApiApplication({ local: localApi, services });

export function runtimeBindings(platform: App.Platform | undefined): RuntimeBindings {
  return {
    ...privateEnvironment,
    ...(platform?.env ?? {}),
  };
}
