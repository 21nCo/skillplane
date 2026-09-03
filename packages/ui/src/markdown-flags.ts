export type MarkdownRendererId = "mdfn" | "legacy";

const DISABLED = new Set(["0", "false", "off", "legacy"]);

function envRecord(): Readonly<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};
  if (typeof process !== "undefined") Object.assign(values, process.env);
  Object.assign(
    values,
    (import.meta as ImportMeta & { readonly env?: NodeJS.ProcessEnv }).env,
  );
  return values;
}

function flagValue(name: string): string | undefined {
  const env = envRecord();
  const value = env[name] ?? env[`PUBLIC_${name}`];
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : undefined;
}

export function isMdfnRendererEnabled(): boolean {
  const value = flagValue("SKILLPLANE_MDFN_RENDERER");
  return value === undefined || !DISABLED.has(value);
}

export function markdownRendererId(): MarkdownRendererId {
  return isMdfnRendererEnabled() ? "mdfn" : "legacy";
}
