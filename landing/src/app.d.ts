declare global {
  namespace App {
    interface Error {
      code?: string;
      message: string;
    }

    interface Platform {
      env: {
        SKILLPLANE_APP_ORIGIN?: string;
      };
      context: {
        waitUntil(promise: Promise<unknown>): void;
        passThroughOnException(): void;
      };
      caches: CacheStorage;
    }
  }
}

export {};
