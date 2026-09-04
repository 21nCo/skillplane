import { defaultExtensions } from "@mdfn/extensions";
import { SKILLPLANE_MARKDOWN_OPTIONS } from "@skillplane/ui";
import type { Component } from "svelte";
import type { MarkdownEditorMode } from "./types.js";

export interface SkillplaneVisualEditorHandle {
  focus(): void;
}

export interface SkillplaneVisualEditorProps {
  controller: SkillplaneEditorController;
  mode?: Extract<MarkdownEditorMode, "visual" | "split"> | "source" | "preview";
  readOnly?: boolean;
  ariaLabel?: string;
  class?: string;
  onLoadError?: (error: Error) => void;
  editorRef?: (value: SkillplaneVisualEditorHandle | null) => void;
}

export interface SkillplaneEditorController {
  getState(): { readonly markdown: string };
  subscribe(
    listener: (change: { readonly current: { readonly markdown: string } }) => void,
  ): () => void;
  destroy?(): void;
}

export interface LoadedMarkdownEditor {
  readonly MdfnEditor: Component<SkillplaneVisualEditorProps>;
  createController(markdown: string): SkillplaneEditorController;
}

let loading: Promise<LoadedMarkdownEditor> | undefined;

export function loadMarkdownEditor(): Promise<LoadedMarkdownEditor> {
  loading ??= Promise.all([
    import("@mdfn/svelte"),
    import("@mdfn/core"),
    import("@mdfn/markdown"),
  ])
    .then(([svelte, core, markdown]) => ({
      MdfnEditor:
        svelte.MdfnEditor as unknown as Component<SkillplaneVisualEditorProps>,
      createController(source: string) {
        return core.createEditor({
          markdown: source,
          projector: markdown.createMarkdownProjector(SKILLPLANE_MARKDOWN_OPTIONS),
          extensions: defaultExtensions,
        });
      },
    }))
    .catch((cause: unknown) => {
      resetMarkdownEditorLoader();
      throw cause;
    });
  return loading;
}

export function resetMarkdownEditorLoader(): void {
  loading = undefined;
}
