import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import {
  appOrigin,
  getPublicSkill,
  listPublicSkillVersions,
  PublicApiError,
} from "$lib/server/public-api.js";
import { publicSkillFilePath } from "$lib/public-skills.js";

const MAX_RENDERED_MARKDOWN_BYTES = 2 * 1024 * 1024;

export const load: PageServerLoad = async ({ fetch, params, platform, setHeaders }) => {
  const origin = appOrigin(platform);
  try {
    const [detailResult, versionsResult] = await Promise.all([
      getPublicSkill(fetch, origin, params.workspaceSlug, params.skillSlug),
      listPublicSkillVersions(fetch, origin, params.workspaceSlug, params.skillSlug),
    ]);
    const { skill, version } = detailResult.data;
    const contentPath = publicSkillFilePath({
      workspaceSlug: params.workspaceSlug,
      skillSlug: params.skillSlug,
      versionId: version.id,
      digest: version.digest,
      path: "SKILL.md",
    });
    const contentResponse = await fetch(new URL(contentPath, origin), {
      headers: { accept: "text/markdown, text/plain;q=0.9" },
    });
    if (!contentResponse.ok) {
      throw new PublicApiError(
        contentResponse.status,
        "PUBLIC_SKILL_CONTENT_UNAVAILABLE",
        "The published skill content could not be loaded.",
      );
    }
    const declaredLength = Number(contentResponse.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_RENDERED_MARKDOWN_BYTES
    ) {
      throw new PublicApiError(
        502,
        "PUBLIC_SKILL_CONTENT_TOO_LARGE",
        "The published skill content is too large to render.",
      );
    }
    const contentBytes = new Uint8Array(await contentResponse.arrayBuffer());
    if (contentBytes.byteLength > MAX_RENDERED_MARKDOWN_BYTES) {
      throw new PublicApiError(
        502,
        "PUBLIC_SKILL_CONTENT_TOO_LARGE",
        "The published skill content is too large to render.",
      );
    }
    let markdown: string;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
    } catch {
      throw new PublicApiError(
        502,
        "PUBLIC_SKILL_CONTENT_INVALID",
        "The published skill content is not valid UTF-8.",
      );
    }
    setHeaders({
      "cache-control": "public, max-age=0, must-revalidate",
    });
    return {
      workspaceSlug: params.workspaceSlug,
      skill,
      version,
      versions: versionsResult.data.versions,
      markdown,
      contentUrl: new URL(contentPath, origin).toString(),
    };
  } catch (caught) {
    if (caught instanceof PublicApiError) {
      if ([401, 403, 404].includes(caught.status)) {
        error(404, {
          code: "PUBLIC_SKILL_NOT_FOUND",
          message: "The public skill was not found.",
        });
      }
      error(caught.status >= 500 ? 503 : caught.status, {
        code: caught.code,
        message: caught.message,
      });
    }
    throw caught;
  }
};
