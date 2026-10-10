import { redirect } from "@sveltejs/kit";
import { loadBrowserSession } from "$lib/server/browser-session.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ platform, request, url }) => {
  const session = await loadBrowserSession({ platform, request, url });
  if (session) redirect(303, "/workspaces");
  return {};
};
