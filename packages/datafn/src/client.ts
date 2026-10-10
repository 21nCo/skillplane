import {
  createDatafnClient,
  createDatafnHttpRouteProvider,
  type DatafnClient,
  type DatafnHttpTransportOptions,
  type DatafnRemoteAdapter,
} from "@datafn/client";
export { createDatafnHttpRouteProvider };
import type { DatafnRouteProvider } from "@datafn/core";
import { skillplaneDatafnSchema } from "./schema.js";

export interface SkillplaneDatafnClientOptions {
  readonly clientId: string;
  readonly remote?: string;
  readonly remoteAdapter?: DatafnRemoteAdapter;
  readonly routeProvider?: DatafnRouteProvider;
  readonly http?: DatafnHttpTransportOptions;
  readonly namespace?: string;
}

export type SkillplaneDatafnClient = DatafnClient<typeof skillplaneDatafnSchema>;

export function createSkillplaneDatafnClient(
  options: SkillplaneDatafnClientOptions,
): DatafnClient<typeof skillplaneDatafnSchema> {
  if (!options.remote && !options.remoteAdapter && !options.routeProvider) {
    throw new Error("A DataFn remote URL, adapter, or route provider is required");
  }
  return createDatafnClient({
    schema: skillplaneDatafnSchema,
    clientId: options.clientId,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    sync: {
      mode: "sync",
      owner: "javascript",
      offlinability: false,
      ws: false,
      ...(options.remote ? { remote: options.remote } : {}),
      ...(options.remoteAdapter ? { remoteAdapter: options.remoteAdapter } : {}),
      ...(options.routeProvider ? { routeProvider: options.routeProvider } : {}),
      ...(options.http ? { http: options.http } : {}),
    },
  });
}
