export const DEFAULT_SKILLPLANE_POSTGRES_PORT = 5_703;
export const LEGACY_DEFAULT_SKILLPLANE_POSTGRES_PORT = 5_432;
export const PREVIOUS_DEFAULT_SKILLPLANE_POSTGRES_PORT = 55_432;

export function selectLocalPostgresPort(configuredPort, persistedPort) {
  if (configuredPort !== undefined) return configuredPort;
  if (
    persistedPort === LEGACY_DEFAULT_SKILLPLANE_POSTGRES_PORT ||
    persistedPort === PREVIOUS_DEFAULT_SKILLPLANE_POSTGRES_PORT
  ) {
    return DEFAULT_SKILLPLANE_POSTGRES_PORT;
  }
  return persistedPort ?? DEFAULT_SKILLPLANE_POSTGRES_PORT;
}

function withPort(value, port) {
  const url = new URL(value);
  url.port = String(port);
  return url.toString();
}

export function rebindLocalRuntimePort(runtime, port) {
  return {
    ...runtime,
    port,
    databaseUrl: withPort(runtime.databaseUrl, port),
    ...(typeof runtime.testDatabaseUrl === "string"
      ? { testDatabaseUrl: withPort(runtime.testDatabaseUrl, port) }
      : {}),
  };
}
