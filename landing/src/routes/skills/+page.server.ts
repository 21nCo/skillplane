import type { PageServerLoad } from "./$types";
import { appOrigin, listPublicSkills, PublicApiError } from "$lib/server/public-api.js";
import type { PublicSkillPage } from "$lib/public-skills.js";

const EMPTY_PAGE: PublicSkillPage = { skills: [], nextCursor: null };

export const load: PageServerLoad = async ({ fetch, platform, setHeaders, url }) => {
  const query = url.searchParams.get("q")?.trim().replace(/\s+/g, " ") ?? "";
  if (query.length > 500) {
    return {
      query,
      page: EMPTY_PAGE,
      error: "Search terms must be 500 characters or fewer.",
    };
  }
  const parameters = new URLSearchParams({ limit: "12" });
  if (query) parameters.set("q", query);
  try {
    const result = await listPublicSkills(fetch, appOrigin(platform), parameters);
    setHeaders({
      "cache-control": "public, max-age=0, must-revalidate",
    });
    return { query, page: result.data, error: null };
  } catch (caught) {
    const message =
      caught instanceof PublicApiError
        ? caught.message
        : "Public skill discovery is temporarily unavailable.";
    return { query, page: EMPTY_PAGE, error: message };
  }
};
