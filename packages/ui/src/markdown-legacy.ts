import { Marked, Renderer, type Tokens } from "marked";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHref(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../")
  ) {
    return trimmed.startsWith("//") ? null : trimmed;
  }
  try {
    const url = new URL(trimmed);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const renderer = new Renderer();
renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);
renderer.link = function ({ href, title, tokens }: Tokens.Link) {
  const label = this.parser.parseInline(tokens);
  const safe = safeHref(href);
  if (!safe) return label;
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
  const external = /^https?:/u.test(safe)
    ? ' target="_blank" rel="noreferrer noopener"'
    : "";
  return `<a href="${escapeHtml(safe)}"${titleAttribute}${external}>${label}</a>`;
};
renderer.image = function ({ href, title, text }: Tokens.Image) {
  const safe = safeHref(href);
  if (!safe || safe.startsWith("mailto:")) return escapeHtml(text);
  const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
  return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(
    text,
  )}"${titleAttribute} loading="lazy" decoding="async">`;
};

const parser = new Marked({
  async: false,
  breaks: false,
  gfm: true,
  renderer,
});

export function renderLegacyMarkdown(markdown: string): string {
  const rendered = parser.parse(markdown, { async: false });
  return typeof rendered === "string" ? rendered : "";
}
