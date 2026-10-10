<script lang="ts">
  import { XIcon } from "phosphor-svelte";
  import { tick, type Snippet } from "svelte";
  import IconButton from "./IconButton.svelte";

  interface Props {
    open?: boolean;
    title: string;
    description?: string;
    children: Snippet;
    footer?: Snippet;
    closeLabel?: string;
    onOpenChange?: (open: boolean) => void;
  }

  const componentId = $props.id();
  const titleId = `${componentId}-title`;
  const descriptionId = `${titleId}-description`;
  let {
    open = $bindable(false),
    title,
    description,
    children,
    footer,
    closeLabel = "Close dialog",
    onOpenChange,
  }: Props = $props();
  let dialog = $state<HTMLDialogElement>();
  let opener: HTMLElement | null = null;

  function requestClose() {
    open = false;
    onOpenChange?.(false);
  }

  function handleBackdrop(event: MouseEvent) {
    if (event.target === dialog) requestClose();
  }

  $effect(() => {
    const activeDialog = dialog;
    if (!activeDialog) return;
    if (open && !activeDialog.open) {
      opener =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      activeDialog.showModal();
      void tick().then(() => {
        activeDialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
      });
    } else if (!open && activeDialog.open) {
      activeDialog.close();
      opener?.focus();
    }
  });
</script>

<dialog
  bind:this={dialog}
  aria-labelledby={titleId}
  aria-describedby={description ? descriptionId : undefined}
  oncancel={(event) => {
    event.preventDefault();
    requestClose();
  }}
  onclick={handleBackdrop}
>
  <section class="panel">
    <header>
      <div>
        <h2 id={titleId}>{title}</h2>
        {#if description}<p id={descriptionId}>{description}</p>{/if}
      </div>
      <IconButton label={closeLabel} onclick={requestClose}>
        <XIcon weight="bold" />
      </IconButton>
    </header>
    <div class="body">{@render children()}</div>
    {#if footer}<footer>{@render footer()}</footer>{/if}
  </section>
</dialog>

<style>
  dialog {
    width: min(calc(100% - var(--sp-space-6)), 32rem);
    max-height: min(calc(100dvh - var(--sp-space-8)), 48rem);
    margin: auto;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--sp-color-text);
  }

  dialog::backdrop {
    background: var(--sp-color-overlay);
    backdrop-filter: blur(2px);
  }

  .panel {
    overflow: hidden;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface-raised);
    box-shadow: var(--sp-shadow-lg);
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
    padding: var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--sp-font-size-5);
    line-height: var(--sp-line-tight);
  }

  p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  .body {
    overflow: auto;
    max-height: calc(100dvh - 12rem);
    padding: var(--sp-space-4);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-space-2);
    padding: var(--sp-space-3) var(--sp-space-4);
    border-top: 1px solid var(--sp-color-border);
    background: var(--sp-color-surface);
  }

  @media (max-width: 30rem) {
    dialog {
      width: calc(100% - var(--sp-space-4));
    }
  }
</style>
