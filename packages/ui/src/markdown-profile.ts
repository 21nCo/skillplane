import { defaultExtensions } from "@mdfn/extensions";
import {
  parseMarkdown,
  type MarkdownOptions,
  type MarkdownParseResult,
} from "@mdfn/markdown";
import { renderHtml, type RenderPolicy, type RenderResult } from "@mdfn/render";

export const SKILLPLANE_MARKDOWN_PROFILE_NAME = "skillplane.markdown.v1" as const;
export const SKILLPLANE_MARKDOWN_PROFILE_VERSION = "1.0.0" as const;

export const SKILLPLANE_MARKDOWN_OPTIONS: MarkdownOptions = Object.freeze({
  dialect: "gfm",
  allowRawHtml: false,
  extensions: defaultExtensions,
});

export const SKILLPLANE_RENDER_POLICY: RenderPolicy = Object.freeze({
  rawHtml: Object.freeze({ enabled: false }),
  links: Object.freeze({
    allowedSchemes: Object.freeze(["http", "https", "mailto"]),
    allowRelative: true,
    allowProtocolRelative: false,
    externalTarget: "_blank",
    externalRel: "noreferrer noopener",
  }),
  images: Object.freeze({
    allowedSchemes: Object.freeze(["http", "https"]),
    allowRelative: true,
    loading: "lazy",
    decoding: "async",
  }),
  extensions: defaultExtensions,
});

export interface SkillplaneMarkdownInspection {
  readonly profile: typeof SKILLPLANE_MARKDOWN_PROFILE_NAME;
  readonly source: string;
  readonly html: string;
  readonly diagnostics: MarkdownParseResult["diagnostics"];
  readonly renderDiagnostics: RenderResult["diagnostics"];
}

function hasErrorDiagnostics(
  diagnostics: readonly { readonly severity: string }[],
): boolean {
  return diagnostics.some((entry) => entry.severity === "error");
}

function firstErrorMessage(
  diagnostics: readonly { readonly severity: string; readonly message: string }[],
  fallback: string,
): string {
  return diagnostics.find((entry) => entry.severity === "error")?.message ?? fallback;
}

export function parseSkillplaneMarkdown(source: string): MarkdownParseResult {
  return parseMarkdown(source, SKILLPLANE_MARKDOWN_OPTIONS);
}

export function renderSkillplaneMarkdown(source: string): RenderResult {
  const parsed = parseSkillplaneMarkdown(source);
  if (hasErrorDiagnostics(parsed.diagnostics)) {
    throw new Error(
      firstErrorMessage(
        parsed.diagnostics,
        "Markdown parse produced error diagnostics",
      ),
    );
  }
  const rendered = renderHtml(parsed.document, SKILLPLANE_RENDER_POLICY);
  if (hasErrorDiagnostics(rendered.diagnostics)) {
    throw new Error(
      firstErrorMessage(
        rendered.diagnostics,
        "Markdown render produced error diagnostics",
      ),
    );
  }
  return rendered;
}

export function inspectSkillplaneMarkdown(
  source: string,
): SkillplaneMarkdownInspection {
  const parsed = parseSkillplaneMarkdown(source);
  const rendered = renderHtml(parsed.document, SKILLPLANE_RENDER_POLICY);
  return {
    profile: SKILLPLANE_MARKDOWN_PROFILE_NAME,
    source,
    html: rendered.html,
    diagnostics: parsed.diagnostics,
    renderDiagnostics: rendered.diagnostics,
  };
}
