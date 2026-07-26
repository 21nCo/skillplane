import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { appOrigin } from "$lib/server/public-api.js";

const ALLOWED_QUERY_PARAMETERS = new Set(["q", "tag", "tags", "limit", "cursor"]);

export const GET: RequestHandler = async ({ fetch, platform, url }) => {
  const query = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (ALLOWED_QUERY_PARAMETERS.has(key)) query.append(key, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      new URL(`/api/v1/skills/public?${query.toString()}`, appOrigin(platform)),
      { headers: { accept: "application/json" } },
    );
  } catch {
    return json(
      {
        ok: false,
        error: {
          code: "PUBLIC_API_UNAVAILABLE",
          message: "Public skill discovery is temporarily unavailable.",
          requestId: "",
        },
      },
      {
        status: 503,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
  const headers = new Headers({
    "cache-control":
      upstream.headers.get("cache-control") ?? "public, max-age=0, must-revalidate",
    "content-type":
      upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
  });
  const etag = upstream.headers.get("etag");
  if (etag) headers.set("etag", etag);
  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
};
