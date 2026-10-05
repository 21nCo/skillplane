import { renderSkillplaneMarkdown } from "./markdown-profile.js";

export function renderSafeMarkdown(markdown: string): string {
  try {
    return renderSkillplaneMarkdown(markdown).html;
  } catch {
    // Stored content can exceed the renderer's limits without exceeding storage
    // limits. Preserve readable source without emitting executable markup/URLs.
    const escaped = markdown
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    return `<pre>${escaped}</pre>`;
  }
}
