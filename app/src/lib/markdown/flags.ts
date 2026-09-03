import type { MarkdownEditorSurface } from "./types.js";

const DISABLED = new Set(["0", "false", "off", "legacy"]);

const SURFACE_FLAGS: Record<MarkdownEditorSurface, string> = {
  "skill-create": "SKILLPLANE_MDFN_EDITOR_SKILL_CREATE",
  "skill-amend": "SKILLPLANE_MDFN_EDITOR_SKILL_AMEND",
  "context-create": "SKILLPLANE_MDFN_EDITOR_CONTEXT_CREATE",
  "knowledge-revise": "SKILLPLANE_MDFN_EDITOR_KNOWLEDGE",
  note: "SKILLPLANE_MDFN_EDITOR_NOTE",
};

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

function isEnabled(name: string): boolean {
  const value = flagValue(name);
  return value === undefined || !DISABLED.has(value);
}

export function isMarkdownEditorEnabled(surface: MarkdownEditorSurface): boolean {
  return isEnabled("SKILLPLANE_MDFN_EDITOR") && isEnabled(SURFACE_FLAGS[surface]);
}
