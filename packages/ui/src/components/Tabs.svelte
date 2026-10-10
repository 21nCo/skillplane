<script lang="ts">
  import type { Snippet } from "svelte";

  export interface TabItem {
    readonly id: string;
    readonly label: string;
    readonly badge?: string;
    readonly disabled?: boolean;
  }

  interface Props {
    label: string;
    tabs: readonly TabItem[];
    value?: string;
    children: Snippet<[string]>;
    onChange?: (id: string) => void;
  }

  let { label, tabs, value = $bindable(""), children, onChange }: Props = $props();
  let tablist: HTMLDivElement;

  function select(tab: TabItem) {
    if (tab.disabled) return;
    value = tab.id;
    onChange?.(tab.id);
  }

  function keydown(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [
      ...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'),
    ];
    const active = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (active + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
            buttons.length;
    event.preventDefault();
    buttons[next]?.focus();
    buttons[next]?.click();
  }
</script>

<div
  class="tablist"
  role="tablist"
  tabindex="-1"
  aria-label={label}
  bind:this={tablist}
  onkeydown={keydown}
>
  {#each tabs as tab (tab.id)}
    <button
      type="button"
      role="tab"
      id={`${tab.id}-tab`}
      aria-selected={value === tab.id}
      aria-controls={`${tab.id}-panel`}
      tabindex={value === tab.id ? 0 : -1}
      disabled={tab.disabled}
      onclick={() => select(tab)}
    >
      {tab.label}
      {#if tab.badge}<span>{tab.badge}</span>{/if}
    </button>
  {/each}
</div>
<div
  class="panel"
  role="tabpanel"
  id={`${value}-panel`}
  aria-labelledby={`${value}-tab`}
>
  {@render children(value)}
</div>

<style>
  .tablist {
    display: flex;
    overflow-x: auto;
    gap: var(--sp-space-1);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .tablist button {
    position: relative;
    display: inline-flex;
    min-height: 2.25rem;
    align-items: center;
    gap: var(--sp-space-2);
    border: 0;
    padding: 0 var(--sp-space-2);
    background: transparent;
    color: var(--sp-color-text-muted);
    cursor: pointer;
    font-size: var(--sp-font-size-3);
    white-space: nowrap;
  }

  .tablist button::after {
    position: absolute;
    right: var(--sp-space-2);
    bottom: -1px;
    left: var(--sp-space-2);
    height: 2px;
    background: transparent;
    content: "";
  }

  .tablist button[aria-selected="true"] {
    color: var(--sp-color-text);
  }

  .tablist button[aria-selected="true"]::after {
    background: var(--sp-color-accent);
  }

  .tablist button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .tablist span {
    border-radius: var(--sp-radius-round);
    padding: 1px var(--sp-space-1);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .panel {
    padding-block: var(--sp-space-4);
  }
</style>
