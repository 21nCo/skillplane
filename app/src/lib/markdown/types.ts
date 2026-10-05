export type MarkdownEditorMode = "source" | "visual" | "split" | "preview";

export type MarkdownEditorLoadState =
  "loading" | "ready" | "source-fallback" | "failed";

export type MarkdownEditorSurface =
  "skill-create" | "skill-amend" | "context-create" | "knowledge-revise" | "note";

export interface MarkdownDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning" | "info";
}
