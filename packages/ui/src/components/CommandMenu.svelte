<script lang="ts">
  import { MagnifyingGlassIcon } from "phosphor-svelte";
  import { tick, type Component } from "svelte";

  export interface CommandItem {
    readonly id: string;
    readonly label: string;
    readonly group: string;
    readonly keywords?: readonly string[];
    readonly shortcut?: string;
    readonly icon?: Component;
    readonly disabledReason?: string;
    readonly run: () => void | Promise<void>;
  }

  interface Props {
    commands: readonly CommandItem[];
    open?: boolean;
    placeholder?: string;
    emptyMessage?: string;
    onOpenChange?: (open: boolean) => void;
  }

  const componentId = $props.id();
  const titleId = `${componentId}-title`;
  let {
    commands,
    open = $bindable(false),
    placeholder = "Search commands…",
    emptyMessage = "No matching commands.",
    onOpenChange,
  }: Props = $props();
  let query = $state("");
  let activeIndex = $state(0);
  let dialog = $state<HTMLDialogElement>();
  let input = $state<HTMLInputElement>();
  let opener: HTMLElement | null = null;
  const filtered = $derived(
    commands.filter((command) => {
      const needle = query.trim().toLocaleLowerCase();
      if (!needle) return true;
      return [command.label, command.group, ...(command.keywords ?? [])]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    }),
  );
  const groups = $derived(
    [...new Set(filtered.map((command) => command.group))].map((group) => ({
      group,
      commands: filtered.filter((command) => command.group === group),
    })),
  );
  const activeCommand = $derived(filtered[activeIndex]);

  function setOpen(next: boolean) {
    open = next;
    onOpenChange?.(next);
    if (!next) {
      query = "";
      activeIndex = 0;
    }
  }

  async function run(command: CommandItem) {
    if (command.disabledReason) return;
    setOpen(false);
    await command.run();
  }

  function keydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeIndex = filtered.length === 0 ? 0 : (activeIndex + 1) % filtered.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeIndex =
        filtered.length === 0
          ? 0
          : (activeIndex - 1 + filtered.length) % filtered.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = filtered[activeIndex];
      if (command) void run(command);
    }
  }

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      opener =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      void tick().then(() => input?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
      opener?.focus();
    }
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
      event.preventDefault();
      setOpen(!open);
    }
  }}
/>

<dialog
  bind:this={dialog}
  aria-labelledby={titleId}
  oncancel={(event) => {
    event.preventDefault();
    setOpen(false);
  }}
  onclick={(event) => {
    if (event.target === dialog) setOpen(false);
  }}
>
  <section>
    <h2 id={titleId} class="sr-only">Command menu</h2>
    <div class="search">
      <MagnifyingGlassIcon size={18} aria-hidden="true" />
      <input
        bind:this={input}
        bind:value={query}
        data-autofocus
        type="search"
        {placeholder}
        aria-label="Search commands"
        aria-controls={`${titleId}-results`}
        aria-activedescendant={activeCommand
          ? `${titleId}-${activeCommand.id}`
          : undefined}
        oninput={() => (activeIndex = 0)}
        onkeydown={keydown}
      />
      <kbd>Esc</kbd>
    </div>
    <div class="results" id={`${titleId}-results`} role="listbox" aria-label="Commands">
      {#if filtered.length === 0}
        <p class="empty">{emptyMessage}</p>
      {:else}
        {#each groups as group (group.group)}
          <div class="group">
            <h3>{group.group}</h3>
            {#each group.commands as command (command.id)}
              {@const index = filtered.indexOf(command)}
              <button
                id={`${titleId}-${command.id}`}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                aria-disabled={command.disabledReason ? "true" : undefined}
                title={command.disabledReason}
                onmouseenter={() => (activeIndex = index)}
                onclick={() => void run(command)}
              >
                <span class="command-icon" aria-hidden="true">
                  {#if command.icon}
                    <command.icon />
                  {:else}
                    <span></span>
                  {/if}
                </span>
                <span>
                  <strong>{command.label}</strong>
                  {#if command.disabledReason}<small>{command.disabledReason}</small
                    >{/if}
                </span>
                {#if command.shortcut}<kbd>{command.shortcut}</kbd>{/if}
              </button>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
    <footer>
      <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
      <span><kbd>↵</kbd> Open</span>
    </footer>
  </section>
</dialog>

<style>
  dialog {
    width: min(calc(100% - var(--sp-space-6)), 38rem);
    max-height: min(36rem, calc(100dvh - var(--sp-space-8)));
    margin: 12vh auto auto;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--sp-color-text);
  }

  dialog::backdrop {
    background: var(--sp-color-overlay);
    backdrop-filter: blur(2px);
  }

  section {
    overflow: hidden;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface-raised);
    box-shadow: var(--sp-shadow-lg);
  }

  .sr-only {
    position: absolute;
    overflow: hidden;
    width: 1px;
    height: 1px;
    clip: rect(0 0 0 0);
  }

  .search {
    display: grid;
    height: 3rem;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: center;
    padding: 0 var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
    color: var(--sp-color-text-subtle);
  }

  input {
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-4);
  }

  input::placeholder {
    color: var(--sp-color-text-subtle);
  }

  input::-webkit-search-cancel-button {
    display: none;
  }

  kbd {
    display: inline-flex;
    min-width: 1.35rem;
    min-height: 1.25rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-sm);
    padding: 0 var(--sp-space-1);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-sans);
    font-size: var(--sp-font-size-1);
    box-shadow: 0 1px 0 var(--sp-color-border-strong);
  }

  .results {
    overflow-y: auto;
    max-height: min(24rem, calc(100dvh - 12rem));
    padding: var(--sp-space-2);
  }

  .group + .group {
    margin-top: var(--sp-space-2);
    padding-top: var(--sp-space-2);
    border-top: 1px solid var(--sp-color-border);
  }

  h3 {
    margin: 0;
    padding: var(--sp-space-1) var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .group button {
    display: grid;
    width: 100%;
    min-height: 2.5rem;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: center;
    border: 0;
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-2);
    background: transparent;
    color: var(--sp-color-text);
    cursor: pointer;
    text-align: left;
  }

  .group button[aria-selected="true"] {
    background: var(--sp-color-surface-hover);
  }

  .group button[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .command-icon {
    display: grid;
    width: 1.75rem;
    height: 1.75rem;
    place-items: center;
    border-radius: var(--sp-radius-sm);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-muted);
  }

  .command-icon :global(svg) {
    width: var(--sp-icon-md);
    height: var(--sp-icon-md);
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

  .empty {
    margin: 0;
    padding: var(--sp-space-8);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    text-align: center;
  }

  footer {
    display: flex;
    gap: var(--sp-space-4);
    padding: var(--sp-space-2) var(--sp-space-4);
    border-top: 1px solid var(--sp-color-border);
    background: var(--sp-color-surface);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  footer span {
    display: inline-flex;
    gap: var(--sp-space-1);
    align-items: center;
  }
</style>
