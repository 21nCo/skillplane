<script lang="ts">
  import { CaretDownIcon, CheckIcon } from "phosphor-svelte";
  import { tick } from "svelte";
  import Button from "./Button.svelte";

  export interface DropdownItem {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly disabled?: boolean;
    readonly danger?: boolean;
  }

  interface Props {
    label: string;
    items: readonly DropdownItem[];
    selectedId?: string;
    align?: "start" | "end";
    disabled?: boolean;
    onSelect: (item: DropdownItem) => void;
  }

  let {
    label,
    items,
    selectedId,
    align = "start",
    disabled = false,
    onSelect,
  }: Props = $props();
  let open = $state(false);
  let root = $state<HTMLDivElement>();
  let menu = $state<HTMLDivElement>();

  function focusItem(index: number) {
    const entries = menu?.querySelectorAll<HTMLButtonElement>("[role=menuitem]");
    entries?.[Math.max(0, Math.min(index, entries.length - 1))]?.focus();
  }

  async function toggle() {
    if (disabled) return;
    open = !open;
    if (open) {
      await tick();
      focusItem(0);
    }
  }

  function keydown(event: KeyboardEvent) {
    if (!menu) return;
    const entries = [...menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    const current = entries.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem((current + 1) % entries.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem((current - 1 + entries.length) % entries.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(entries.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      open = false;
      root?.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")?.focus();
    }
  }

  function select(item: DropdownItem) {
    if (item.disabled) return;
    onSelect(item);
    open = false;
    root?.querySelector<HTMLButtonElement>("[aria-haspopup=menu]")?.focus();
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (open && root && !root.contains(event.target as Node)) open = false;
  }}
/>

<div class="root" bind:this={root}>
  <Button
    variant="secondary"
    {disabled}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={toggle}
  >
    {label}
    {#snippet trailing()}<CaretDownIcon size={14} weight="bold" />{/snippet}
  </Button>
  {#if open}
    <div
      class="menu"
      class:align-end={align === "end"}
      bind:this={menu}
      role="menu"
      tabindex="-1"
      aria-label={label}
      onkeydown={keydown}
    >
      {#each items as item (item.id)}
        <button
          type="button"
          role="menuitem"
          disabled={item.disabled}
          class:danger={item.danger}
          onclick={() => select(item)}
        >
          <span>
            <strong>{item.label}</strong>
            {#if item.description}<small>{item.description}</small>{/if}
          </span>
          {#if item.id === selectedId}
            <CheckIcon size={14} weight="bold" aria-hidden="true" />
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .root {
    position: relative;
    display: inline-block;
  }

  .menu {
    position: absolute;
    z-index: var(--sp-z-dropdown);
    top: calc(100% + var(--sp-space-1));
    left: 0;
    display: grid;
    width: max-content;
    min-width: 13rem;
    max-width: min(20rem, calc(100vw - var(--sp-space-6)));
    gap: 1px;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-1);
    background: var(--sp-color-surface-raised);
    box-shadow: var(--sp-shadow-md);
  }

  .menu.align-end {
    right: 0;
    left: auto;
  }

  .menu button {
    display: flex;
    min-height: 2.25rem;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
    border: 0;
    border-radius: var(--sp-radius-sm);
    padding: var(--sp-space-2);
    background: transparent;
    color: var(--sp-color-text);
    cursor: pointer;
    text-align: left;
  }

  .menu button:hover:not(:disabled),
  .menu button:focus-visible {
    background: var(--sp-color-surface-hover);
  }

  .menu button.danger {
    color: var(--sp-color-danger);
  }

  .menu button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  strong,
  small {
    display: block;
  }

  strong {
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
  }

  small {
    margin-top: 2px;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }
</style>
