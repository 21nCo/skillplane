import { isMdfnRendererEnabled } from "./markdown-flags.js";
import { renderLegacyMarkdown } from "./markdown-legacy.js";
import { renderSkillplaneMarkdown } from "./markdown-profile.js";

export function renderSafeMarkdown(markdown: string): string {
  if (!isMdfnRendererEnabled()) {
    return renderLegacyMarkdown(markdown);
  }
  try {
    return renderSkillplaneMarkdown(markdown).html;
  } catch {
    return renderLegacyMarkdown(markdown);
  }
}
