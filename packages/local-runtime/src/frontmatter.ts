import { parseDocument } from "yaml";
import { RuntimeError } from "./contracts.js";

export function skillFrontmatter(body: string): Record<string, unknown> {
  const text = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1];
  if (text === undefined) return {};
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new RuntimeError("FRONTMATTER_INVALID");
  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new RuntimeError("FRONTMATTER_INVALID");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new RuntimeError("FRONTMATTER_INVALID");
  return data as Record<string, unknown>;
}
