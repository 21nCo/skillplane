import type { LayoutLoad } from "./$types";

export const load: LayoutLoad = ({ params }) => ({
  workspaceSlug: params.workspaceSlug,
  skillSlug: params.skillSlug,
});
