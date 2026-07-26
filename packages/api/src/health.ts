import {
  parseRuntimeConfig,
  safeConfigDiagnostic,
  type RuntimeBindings,
} from "@skillplane/config";
import pg from "pg";

const { Client } = pg;

export interface HealthCheck {
  readonly ok: boolean;
  readonly code: string;
  readonly latencyMs: number;
}

export interface ReadinessResult {
  readonly ok: boolean;
  readonly checks: {
    readonly configuration: HealthCheck;
    readonly postgres: HealthCheck;
    readonly objectStorage: HealthCheck;
  };
}

export type ReadinessProbe = (bindings: RuntimeBindings) => Promise<ReadinessResult>;

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error("HEALTH_CHECK_TIMEOUT")),
      timeoutMilliseconds,
    );
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

export function createReadinessProbe(options?: {
  readonly timeoutMilliseconds?: number;
}): ReadinessProbe {
  const timeoutMilliseconds = options?.timeoutMilliseconds ?? 2_500;

  return async (bindings) => {
    const configurationStartedAt = performance.now();
    let config;
    try {
      config = parseRuntimeConfig(bindings);
    } catch (error) {
      const diagnostic = safeConfigDiagnostic(error);
      const blocked = {
        ok: false,
        code: "CHECK_BLOCKED",
        latencyMs: 0,
      } as const;
      return {
        ok: false,
        checks: {
          configuration: {
            ok: false,
            code: diagnostic.code,
            latencyMs: elapsed(configurationStartedAt),
          },
          postgres: blocked,
          objectStorage: blocked,
        },
      };
    }

    const configuration: HealthCheck = {
      ok: true,
      code: "CONFIG_VALID",
      latencyMs: elapsed(configurationStartedAt),
    };

    const postgresStartedAt = performance.now();
    const postgresCheck = withTimeout(
      (async (): Promise<HealthCheck> => {
        const client = new Client({
          connectionString: config.database.connectionString,
          connectionTimeoutMillis: timeoutMilliseconds,
          query_timeout: timeoutMilliseconds,
        });
        try {
          await client.connect();
          await client.query("select 1 as ready");
          return {
            ok: true,
            code: "POSTGRES_READY",
            latencyMs: elapsed(postgresStartedAt),
          };
        } finally {
          await client.end().catch(() => undefined);
        }
      })(),
      timeoutMilliseconds,
    ).catch((): HealthCheck => ({
      ok: false,
      code: "POSTGRES_UNAVAILABLE",
      latencyMs: elapsed(postgresStartedAt),
    }));

    const objectStorageStartedAt = performance.now();
    const objectStorageCheck = withTimeout(
      config.objectStorage.list({ limit: 1 }).then((): HealthCheck => ({
        ok: true,
        code: "R2_READY",
        latencyMs: elapsed(objectStorageStartedAt),
      })),
      timeoutMilliseconds,
    ).catch((): HealthCheck => ({
      ok: false,
      code: "R2_UNAVAILABLE",
      latencyMs: elapsed(objectStorageStartedAt),
    }));

    const [postgres, objectStorage] = await Promise.all([
      postgresCheck,
      objectStorageCheck,
    ]);

    return {
      ok: postgres.ok && objectStorage.ok,
      checks: {
        configuration,
        postgres,
        objectStorage,
      },
    };
  };
}
