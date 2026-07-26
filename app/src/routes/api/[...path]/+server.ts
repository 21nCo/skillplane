import { api, runtimeBindings } from "$lib/server/api.js";
import type { RequestHandler } from "./$types";

const handle: RequestHandler = async ({ request, platform }) => {
  return api.fetch(request, runtimeBindings(platform));
};

export const DELETE = handle;
export const GET = handle;
export const OPTIONS = handle;
export const PATCH = handle;
export const POST = handle;
export const PUT = handle;
