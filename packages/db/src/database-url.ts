import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface LocalRuntimeFile {
  readonly databaseUrl?: unknown;
  readonly testDatabaseUrl?: unknown;
}

const moduleParent = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const packageRoot =
  basename(moduleParent) === "dist" ? resolve(moduleParent, "..") : moduleParent;
export const projectRoot = resolve(packageRoot, "..", "..");

function requirePostgresUrl(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new Error(`${source} does not contain a Postgres connection string`);
  }
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.pathname.slice(1)
  ) {
    throw new Error(`${source} is not a valid Postgres connection string`);
  }
  return value;
}

async function readLocalRuntime(): Promise<LocalRuntimeFile> {
  const path = resolve(projectRoot, ".data", "local-runtime.json");
  return JSON.parse(await readFile(path, "utf8")) as LocalRuntimeFile;
}

export async function resolveMigrationDatabaseUrl(): Promise<string> {
  const configured = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (configured) {
    return requirePostgresUrl(configured, "database environment");
  }
  const runtime = await readLocalRuntime();
  return requirePostgresUrl(runtime.databaseUrl, ".data/local-runtime.json");
}

export async function resolveTestDatabaseUrl(): Promise<string> {
  if (process.env.TEST_DATABASE_URL) {
    return requirePostgresUrl(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
  }
  const runtime = await readLocalRuntime();
  if (runtime.testDatabaseUrl) {
    return requirePostgresUrl(runtime.testDatabaseUrl, ".data/local-runtime.json");
  }
  const source = new URL(
    requirePostgresUrl(runtime.databaseUrl, ".data/local-runtime.json"),
  );
  source.pathname = "/skillplane_test";
  return source.toString();
}

export function assertDisposableDatabaseUrl(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.slice(1);
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (!localHost || !databaseName.endsWith("_test")) {
    throw new Error(
      `Refusing destructive reset for non-local/non-test database "${parsed.hostname}/${databaseName}"`,
    );
  }
}
