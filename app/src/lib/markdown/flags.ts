import { env as publicEnv } from "$env/dynamic/public";
import type { MarkdownEditorSurface } from "./types.js";

const DISABLED = new Set(["0", "false", "off", "legacy"]);

export const MARKDOWN_EDITOR_FLAG_NAMES = [
  "SKILLPLANE_MDFN_EDITOR",
  "SKILLPLANE_MDFN_EDITOR_SKILL_CREATE",
  "SKILLPLANE_MDFN_EDITOR_SKILL_AMEND",
  "SKILLPLANE_MDFN_EDITOR_CONTEXT_CREATE",
  "SKILLPLANE_MDFN_EDITOR_KNOWLEDGE",
  "SKILLPLANE_MDFN_EDITOR_NOTE",
] as const;

const SURFACE_FLAGS: Record<MarkdownEditorSurface, string> = {
  "skill-create": "SKILLPLANE_MDFN_EDITOR_SKILL_CREATE",
  "skill-amend": "SKILLPLANE_MDFN_EDITOR_SKILL_AMEND",
  "context-create": "SKILLPLANE_MDFN_EDITOR_CONTEXT_CREATE",
  "knowledge-revise": "SKILLPLANE_MDFN_EDITOR_KNOWLEDGE",
  note: "SKILLPLANE_MDFN_EDITOR_NOTE",
};

function stringRecord(source: unknown): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  if (!source || typeof source !== "object") return values;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") values[key] = value;
  }
  return values;
}

function envRecord(): Readonly<Record<string, string | undefined>> {
  const values: Record<string, string | undefined> = {};
  if (typeof process !== "undefined") {
    Object.assign(values, stringRecord(process.env));
  }
  Object.assign(values, stringRecord(publicEnv));
  return values;
}

function flagValue(name: string): string | undefined {
  const env = envRecord();
  const value = env[`PUBLIC_${name}`] ?? env[name];
  return typeof value === "string" ? value.trim().toLocaleLowerCase() : undefined;
}

function isEnabled(name: string): boolean {
  const value = flagValue(name);
  return value === undefined || !DISABLED.has(value);
}

export function isMarkdownEditorEnabled(surface: MarkdownEditorSurface): boolean {
  return isEnabled("SKILLPLANE_MDFN_EDITOR") && isEnabled(SURFACE_FLAGS[surface]);
}
