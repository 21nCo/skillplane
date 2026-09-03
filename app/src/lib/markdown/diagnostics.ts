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
