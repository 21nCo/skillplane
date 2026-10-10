import { redirect } from "@sveltejs/kit";
import { loadBrowserSession } from "$lib/server/browser-session.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ platform, request, url }) => {
  const session = await loadBrowserSession({ platform, request, url });
  if (!session) {
    const returnTo = `${url.pathname}${url.search}`;
    redirect(303, `/sign-in?next=${encodeURIComponent(returnTo)}`);
  }

  return { session };
};
