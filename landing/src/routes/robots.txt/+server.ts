import type { RequestHandler } from "./$types";
import { SITE_ORIGIN } from "$lib/content.js";

export const GET: RequestHandler = () =>
  new Response(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /api/",
      `Sitemap: ${SITE_ORIGIN}/sitemap.xml`,
      "",
    ].join("\n"),
    {
      headers: {
        "cache-control": "public, max-age=86400",
        "content-type": "text/plain; charset=utf-8",
      },
    },
  );
