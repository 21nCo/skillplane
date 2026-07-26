<script lang="ts">
  import { renderSafeMarkdown } from "../markdown.js";

  let { source }: { source: string } = $props();
  const rendered = $derived(renderSafeMarkdown(source));
</script>

<article class="markdown" data-testid="safe-markdown">
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- renderSafeMarkdown escapes raw HTML and validates every emitted URL. -->
  {@html rendered}
</article>

<style>
  .markdown {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-4);
    line-height: 1.7;
    overflow-wrap: anywhere;
  }

  .markdown :global(:first-child) {
    margin-top: 0;
  }

  .markdown :global(:last-child) {
    margin-bottom: 0;
  }

  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3),
  .markdown :global(h4) {
    margin: 1.5em 0 0.5em;
    color: var(--sp-color-text);
    line-height: var(--sp-line-tight);
  }

  .markdown :global(h1) {
    font-size: var(--sp-font-size-7);
  }

  .markdown :global(h2) {
    padding-bottom: var(--sp-space-2);
    border-bottom: 1px solid var(--sp-color-border);
    font-size: var(--sp-font-size-6);
  }

  .markdown :global(h3) {
    font-size: var(--sp-font-size-5);
  }

  .markdown :global(a) {
    color: var(--sp-color-accent-text);
    text-underline-offset: 0.18em;
  }

  .markdown :global(code) {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-sm);
    padding: 0.1em 0.3em;
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text);
    font-family: var(--sp-font-mono);
    font-size: 0.88em;
  }

  .markdown :global(pre) {
    overflow: auto;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-4);
    background: var(--sp-color-canvas);
  }

  .markdown :global(pre code) {
    border: 0;
    padding: 0;
    background: transparent;
  }

  .markdown :global(blockquote) {
    margin-left: 0;
    border-left: 3px solid var(--sp-color-accent);
    padding-left: var(--sp-space-4);
    color: var(--sp-color-text-subtle);
  }

  .markdown :global(table) {
    display: block;
    overflow: auto;
    width: 100%;
    border-collapse: collapse;
  }

  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--sp-color-border);
    padding: var(--sp-space-2) var(--sp-space-3);
    text-align: left;
  }

  .markdown :global(img) {
    max-width: 100%;
    border-radius: var(--sp-radius-md);
  }
</style>
