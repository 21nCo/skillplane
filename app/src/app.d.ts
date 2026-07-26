import type { RuntimeBindings } from "@skillplane/config";

declare global {
  namespace App {
    interface Error {
      code?: string;
      message: string;
    }

    interface Platform {
      env: RuntimeBindings;
      context: {
        waitUntil(promise: Promise<unknown>): void;
        passThroughOnException(): void;
      };
      caches: CacheStorage;
    }
  }
}

export {};
