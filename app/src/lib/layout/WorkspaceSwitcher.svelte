<script lang="ts">
  import { getPostHog } from "$lib/analytics/posthog.client.js";
  import { CaretDownIcon } from "phosphor-svelte";
  import type { WorkspaceStore } from "$lib/workspaces/store.svelte.js";

  let {
    store,
    compact = false,
  }: {
    store: WorkspaceStore;
    compact?: boolean;
  } = $props();

  function selectWorkspace(event: Event) {
    store.select((event.currentTarget as HTMLSelectElement).value);
    getPostHog()?.capture("workspace_switched");
  }
</script>

<label class:compact>
  <span>Active workspace</span>
  <div>
    <select
      value={store.activeId ?? ""}
      onchange={selectWorkspace}
      aria-label="Active workspace"
      disabled={store.loading || store.workspaces.length === 0}
    >
      {#each store.workspaces as workspace (workspace.id)}
        <option value={workspace.id}>{workspace.name} · {workspace.role}</option>
      {/each}
    </select>
    <CaretDownIcon size={14} weight="bold" aria-hidden="true" />
  </div>
</label>

<style>
  label {
    display: block;
    padding: var(--sp-space-4) var(--sp-space-3) var(--sp-space-2);
  }

  label > span {
    display: block;
    margin: 0 0 var(--sp-space-2) var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  label > div {
    position: relative;
  }

  select {
    width: 100%;
    height: var(--sp-control-height);
    appearance: none;
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: 0 calc(var(--sp-space-4) + var(--sp-icon-sm)) 0 var(--sp-control-padding-x);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text);
    cursor: pointer;
    font-size: var(--sp-font-size-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  select:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  div :global(svg) {
    position: absolute;
    top: 50%;
    right: var(--sp-space-3);
    pointer-events: none;
    color: var(--sp-color-text-subtle);
    transform: translateY(-50%);
  }

  label.compact {
    min-width: 13rem;
    padding: 0;
  }

  label.compact > span {
    position: absolute;
    overflow: hidden;
    width: 1px;
    height: 1px;
    clip: rect(0 0 0 0);
  }
</style>
