import { inspectSkillplaneMarkdown } from "@skillplane/ui";
import type { MarkdownDiagnostic } from "./types.js";

export function markdownDiagnostics(source: string): readonly MarkdownDiagnostic[] {
  try {
    const inspection = inspectSkillplaneMarkdown(source);
    return [...inspection.diagnostics, ...inspection.renderDiagnostics].map(
      (entry) => ({
        code: entry.code,
        message: entry.message,
        severity: entry.severity,
      }),
    );
  } catch (cause) {
    return [
      {
        code: "SKILLPLANE_MARKDOWN_INSPECT_FAILED",
        message:
          cause instanceof Error
            ? cause.message
            : "Markdown diagnostics could not be produced.",
        severity: "error",
      },
    ];
  }
}

export function encodedByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function markdownConstraintMessage(
  value: string,
  options: {
    readonly required?: boolean;
    readonly maxBytes?: number;
    readonly maxCharacters?: number;
  },
): string {
  if (options.required && value.length === 0) return "Markdown is required.";
  if (
    typeof options.maxCharacters === "number" &&
    value.length > options.maxCharacters
  ) {
    return `Markdown exceeds the ${options.maxCharacters.toLocaleString()} character limit.`;
  }
  if (
    typeof options.maxBytes === "number" &&
    encodedByteLength(value) > options.maxBytes
  ) {
    return `Markdown exceeds the ${options.maxBytes.toLocaleString()} byte limit.`;
  }
  return "";
}
