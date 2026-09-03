import { defaultExtensions } from "@mdfn/extensions";
import {
  parseMarkdown,
  type MarkdownOptions,
  type MarkdownParseResult,
} from "@mdfn/markdown";
import { renderHtml, type RenderPolicy, type RenderResult } from "@mdfn/render";

export const SKILLPLANE_MARKDOWN_PROFILE_NAME = "skillplane.markdown.v1" as const;
export const SKILLPLANE_MARKDOWN_PROFILE_VERSION = "1.0.0" as const;

export const SKILLPLANE_MARKDOWN_OPTIONS = Object.freeze({
  dialect: "gfm",
  allowRawHtml: false,
  extensions: defaultExtensions,
}) satisfies MarkdownOptions;

export const SKILLPLANE_RENDER_POLICY = Object.freeze({
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
}) satisfies RenderPolicy;

export interface SkillplaneMarkdownInspection {
  readonly profile: typeof SKILLPLANE_MARKDOWN_PROFILE_NAME;
  readonly source: string;
  readonly html: string;
  readonly diagnostics: MarkdownParseResult["diagnostics"];
  readonly renderDiagnostics: RenderResult["diagnostics"];
}

export function parseSkillplaneMarkdown(source: string): MarkdownParseResult {
  return parseMarkdown(source, SKILLPLANE_MARKDOWN_OPTIONS);
}

export function renderSkillplaneMarkdown(source: string): RenderResult {
  const parsed = parseSkillplaneMarkdown(source);
  return renderHtml(parsed.document, SKILLPLANE_RENDER_POLICY);
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
