import { renderSkillplaneMarkdown } from "./markdown-profile.js";

export function renderSafeMarkdown(markdown: string): string {
  return renderSkillplaneMarkdown(markdown).html;
}
