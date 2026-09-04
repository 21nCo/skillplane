export type MarkdownRendererId = "mdfn" | "legacy";

const DISABLED = new Set(["0", "false", "off", "legacy"]);
const RENDERER_FLAG = "SKILLPLANE_MDFN_RENDERER";

let runtimeEnv: Readonly<Record<string, string | undefined>> = {};

function stringRecord(source: unknown): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  if (!source || typeof source !== "object") return values;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") values[key] = value;
  }
  return values;
}

export function applyMarkdownRendererEnv(next: unknown): void {
  runtimeEnv = stringRecord(next);
}

export function resetMarkdownRendererEnv(): void {
  runtimeEnv = {};
}

function envRecord(): Readonly<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};
  if (typeof process !== "undefined") {
    Object.assign(values, stringRecord(process.env));
  }
  Object.assign(values, runtimeEnv);
  return values;
}

function flagValue(name: string): string | undefined {
  const env = envRecord();
  const value = env[`PUBLIC_${name}`] ?? env[name];
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : undefined;
}

export function isMdfnRendererEnabled(): boolean {
  const value = flagValue(RENDERER_FLAG);
  return value === undefined || !DISABLED.has(value);
}

export function markdownRendererId(): MarkdownRendererId {
  return isMdfnRendererEnabled() ? "mdfn" : "legacy";
}
