<script lang="ts">
  import { apiRequest } from "$lib/api/client.js";
  let {
    workspaceId,
    skillId,
    versionId,
  }: { workspaceId: string; skillId: string; versionId: string } = $props();
  interface Provenance {
    repository_url: string;
    commit_sha: string;
    skill_path: string;
    bundle_digest: string;
    imported_at: string;
  }
  let provenance = $state<Provenance | null>(null),
    error = $state("");
  let generation = 0;
  $effect(() => {
    const w = workspaceId,
      s = skillId,
      v = versionId,
      request = ++generation;
    provenance = null;
    error = "";
    void apiRequest<{ provenance: Provenance | null }>(
      `/api/v1/workspaces/${encodeURIComponent(w)}/skills/${encodeURIComponent(s)}/versions/${encodeURIComponent(v)}/source`,
    )
      .then((r) => {
        if (request === generation) provenance = r.provenance;
      })
      .catch(() => {
        if (request === generation) error = "Source provenance could not be loaded";
      });
    return () => {
      generation++;
    };
  });
</script>

{#if provenance}<section aria-label="Git provenance">
    <h3>Git source</h3>
    <!-- eslint-disable svelte/no-navigation-without-resolve -- validated external GitHub commit URL -->
    <a
      href={`${provenance.repository_url}/commit/${provenance.commit_sha}`}
      target="_blank"
      rel="noreferrer"
      >{provenance.repository_url} · {provenance.commit_sha.slice(0, 12)}</a
    >
    <!-- eslint-enable svelte/no-navigation-without-resolve -->
    <p>Path: <code>{provenance.skill_path || "/"}</code></p>
    <p>Imported: {provenance.imported_at}</p>
    <p>Bundle: <code>{provenance.bundle_digest}</code></p>
  </section>{/if}{#if error}<p role="status">{error}</p>{/if}

<style>
  section {
    overflow-wrap: anywhere;
  }
</style>
