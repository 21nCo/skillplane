<script lang="ts">
  import { Badge, Button, Select } from "@skillplane/ui";
  import { ArrowsOutLineVerticalIcon, ColumnsIcon } from "phosphor-svelte";
  import type { SkillFileDiff } from "./types.js";

  let { files }: { files: readonly SkillFileDiff[] } = $props();
  let mode = $state<"unified" | "side-by-side">("unified");
  let selectedPath = $state("");
  const selected = $derived(
    files.find((file) => file.path === selectedPath) ?? files.at(0),
  );

  $effect(() => {
    if (!selectedPath && files[0]) selectedPath = files[0].path;
  });

  function lines(
    file: SkillFileDiff,
    side: "left" | "right",
  ): readonly { readonly kind: string; readonly value: string }[] {
    return (file.textChanges ?? [])
      .filter((change) =>
        side === "left" ? change.kind !== "added" : change.kind !== "removed",
      )
      .flatMap((change) =>
        change.value
          .split("\n")
          .slice(0, -1)
          .map((value) => ({ kind: change.kind, value })),
      );
  }

  function tone(status: SkillFileDiff["status"]) {
    if (status === "added") return "success" as const;
    if (status === "removed") return "danger" as const;
    if (status === "modified") return "warning" as const;
    return "neutral" as const;
  }
</script>

{#if files.length === 0}
  <p class="empty">These versions have no file differences.</p>
{:else}
  <section class="diff" aria-label="Version file differences">
    <header>
      <Select
        label="Changed file"
        options={files.map((file) => ({
          value: file.path,
          label: `${file.status.toLocaleUpperCase()} · ${file.path}`,
        }))}
        bind:value={selectedPath}
      />
      <div class="modes" aria-label="Diff layout">
        <Button
          size="sm"
          variant={mode === "unified" ? "primary" : "secondary"}
          aria-pressed={mode === "unified"}
          onclick={() => (mode = "unified")}
        >
          {#snippet leading()}
            <ArrowsOutLineVerticalIcon weight="bold" />
          {/snippet}
          Unified
        </Button>
        <Button
          size="sm"
          variant={mode === "side-by-side" ? "primary" : "secondary"}
          aria-pressed={mode === "side-by-side"}
          onclick={() => (mode = "side-by-side")}
        >
          {#snippet leading()}<ColumnsIcon weight="bold" />{/snippet}
          Side by side
        </Button>
      </div>
    </header>

    {#if selected}
      <div class="file-heading">
        <code>{selected.path}</code>
        <Badge tone={tone(selected.status)}>{selected.status}</Badge>
      </div>
      {#if selected.truncated}
        <p class="notice">
          This text diff exceeds the safe display limit. Compare the immutable file
          digests or download both versions.
        </p>
      {:else if selected.textChanges}
        {#if mode === "unified"}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (A focusable scroll region lets keyboard users inspect long diffs.) -->
          <pre
            class="unified"
            tabindex="0"
            aria-label={`Unified diff for ${selected.path}`}>{#each selected.textChanges as change, index (`${change.kind}-${String(index)}`)}<span
                class={change.kind}
                >{change.kind === "added"
                  ? "+"
                  : change.kind === "removed"
                    ? "−"
                    : " "}{change.value}</span
              >{/each}</pre>
        {:else}
          <div class="columns">
            <div>
              <h3>Before</h3>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex (A focusable scroll region lets keyboard users inspect long diffs.) -->
              <pre
                tabindex="0"
                aria-label={`Before ${selected.path}`}>{#each lines(selected, "left") as line, index (`left-${String(index)}`)}<span
                    class={line.kind}
                    >{line.kind === "removed" ? "−" : " "}{line.value}</span
                  >{/each}</pre>
            </div>
            <div>
              <h3>After</h3>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex (A focusable scroll region lets keyboard users inspect long diffs.) -->
              <pre
                tabindex="0"
                aria-label={`After ${selected.path}`}>{#each lines(selected, "right") as line, index (`right-${String(index)}`)}<span
                    class={line.kind}
                    >{line.kind === "added" ? "+" : " "}{line.value}</span
                  >{/each}</pre>
            </div>
          </div>
        {/if}
      {:else}
        <div class="binary">
          <p>
            {selected.status === "unchanged"
              ? "The file digest is unchanged."
              : "This binary or non-text file changed. Its immutable digests are shown below."}
          </p>
          <dl>
            <div>
              <dt>Before</dt>
              <dd>{selected.fromSha256 ?? "Not present"}</dd>
            </div>
            <div>
              <dt>After</dt>
              <dd>{selected.toSha256 ?? "Not present"}</dd>
            </div>
          </dl>
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .diff {
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  header {
    display: grid;
    grid-template-columns: minmax(14rem, 1fr) auto;
    gap: var(--sp-space-4);
    align-items: end;
    padding: var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .modes {
    display: flex;
    gap: var(--sp-space-1);
  }

  .file-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
    padding: var(--sp-space-2) var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
    background: var(--sp-color-surface-muted);
  }

  code,
  pre {
    font-family: var(--sp-font-mono);
  }

  pre {
    overflow: auto;
    max-height: 42rem;
    margin: 0;
    background: var(--sp-color-canvas);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    line-height: 1.55;
  }

  pre span {
    display: block;
    min-width: max-content;
    padding: 0 var(--sp-space-3);
    white-space: pre-wrap;
  }

  pre span.added {
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
  }

  pre span.removed {
    background: var(--sp-color-danger-soft);
    color: var(--sp-color-danger);
  }

  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

  .columns > div + div {
    border-left: 1px solid var(--sp-color-border);
  }

  h3 {
    margin: 0;
    padding: var(--sp-space-2) var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
    text-transform: uppercase;
  }

  .notice,
  .binary,
  .empty {
    margin: 0;
    padding: var(--sp-space-4);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  dl {
    display: grid;
    gap: var(--sp-space-2);
  }

  dl div {
    display: grid;
    grid-template-columns: 5rem minmax(0, 1fr);
    gap: var(--sp-space-2);
  }

  dt {
    color: var(--sp-color-text-subtle);
  }

  dd {
    overflow: hidden;
    margin: 0;
    font-family: var(--sp-font-mono);
    text-overflow: ellipsis;
  }

  @media (max-width: 48rem) {
    header,
    .columns {
      grid-template-columns: 1fr;
    }

    .columns > div + div {
      border-top: 1px solid var(--sp-color-border);
      border-left: 0;
    }
  }
</style>
