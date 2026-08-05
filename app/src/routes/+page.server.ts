import { redirect } from "@sveltejs/kit";
import { loadBrowserSession } from "$lib/server/browser-session.js";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ platform, request, url }) => {
  const session = await loadBrowserSession({ platform, request, url });
  redirect(
    303,
    session ? "/workspaces" : `/sign-in?next=${encodeURIComponent("/workspaces")}`,
  );
};
