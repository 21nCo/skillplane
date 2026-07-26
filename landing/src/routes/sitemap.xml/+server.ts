import type { RequestHandler } from "./$types";
import { SITE_ORIGIN } from "$lib/content.js";
import { appOrigin, listPublicSkills } from "$lib/server/public-api.js";
import { publicSkillPath, type PublicSkillSummary } from "$lib/public-skills.js";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function entry(location: string, lastModified?: string): string {
  return [
    "  <url>",
    `    <loc>${escapeXml(location)}</loc>`,
    ...(lastModified
      ? [`    <lastmod>${escapeXml(lastModified.slice(0, 10))}</lastmod>`]
      : []),
    "  </url>",
  ].join("\n");
}

export const GET: RequestHandler = async ({ fetch, platform }) => {
  const skills: PublicSkillSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 100; page += 1) {
      const parameters = new URLSearchParams({ limit: "100" });
      if (cursor) parameters.set("cursor", cursor);
      const result = await listPublicSkills(fetch, appOrigin(platform), parameters);
      skills.push(...result.data.skills);
      cursor = result.data.nextCursor;
      if (!cursor) break;
      if (seenCursors.has(cursor)) {
        return new Response("Sitemap generation detected a repeated cursor.", {
          status: 503,
          headers: {
            "cache-control": "private, no-store",
            "content-type": "text/plain; charset=utf-8",
          },
        });
      }
      seenCursors.add(cursor);
    }
    if (cursor) {
      return new Response("Sitemap generation exceeded the safe page limit.", {
        status: 503,
        headers: {
          "cache-control": "private, no-store",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }
  } catch {
    return new Response("Sitemap generation is temporarily unavailable.", {
      status: 503,
      headers: {
        "cache-control": "private, no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entry(`${SITE_ORIGIN}/`),
    entry(`${SITE_ORIGIN}/skills`),
    ...skills.map((skill) =>
      entry(
        `${SITE_ORIGIN}${publicSkillPath(skill.workspaceSlug, skill.slug)}`,
        skill.updatedAt,
      ),
    ),
    "</urlset>",
    "",
  ].join("\n");

  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=300, stale-if-error=86400",
      "content-type": "application/xml; charset=utf-8",
    },
  });
};
