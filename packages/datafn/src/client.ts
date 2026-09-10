import {
  createDatafnClient,
  type DatafnClient,
  type DatafnHttpTransportOptions,
  type DatafnRemoteAdapter,
} from "@datafn/client";
import { skillplaneDatafnSchema } from "./schema.js";

export interface SkillplaneDatafnClientOptions {
  readonly clientId: string;
  readonly remote?: string;
  readonly remoteAdapter?: DatafnRemoteAdapter;
  readonly http?: DatafnHttpTransportOptions;
  readonly namespace?: string;
}

export type SkillplaneDatafnClient = DatafnClient<typeof skillplaneDatafnSchema>;

export function createSkillplaneDatafnClient(
  options: SkillplaneDatafnClientOptions,
): DatafnClient<typeof skillplaneDatafnSchema> {
  if (!options.remote && !options.remoteAdapter) {
    throw new Error("A DataFn remote URL or adapter is required");
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
      ...(options.http ? { http: options.http } : {}),
    },
  });
}
