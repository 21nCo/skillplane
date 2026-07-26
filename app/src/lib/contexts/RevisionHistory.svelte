<script lang="ts">
  import { SafeMarkdown } from "@skillplane/ui";
  import { Badge } from "@skillplane/ui";
  import { ClockCounterClockwiseIcon } from "phosphor-svelte";
  import type { ContextKnowledgeRevision, ContextNoteRevision } from "./types.js";

  type Revision = ContextKnowledgeRevision | ContextNoteRevision;

  let {
    revisions,
    kind,
  }: {
    revisions: readonly Revision[];
    kind: "knowledge" | "note";
  } = $props();

  function body(revision: Revision): string {
    return revision.body;
  }

  function title(revision: Revision): string | null {
    return "title" in revision ? revision.title : null;
  }

  function summary(revision: Revision): string {
    return typeof revision.learningMetadata.summary === "string"
      ? revision.learningMetadata.summary
      : "No learning summary supplied";
  }
</script>

<div class="history">
  {#each revisions as revision (revision.id)}
    <article>
      <header>
        <div class="revision-mark" aria-hidden="true">
          <ClockCounterClockwiseIcon weight="duotone" />
        </div>
        <div>
          <div class="title-row">
            <h3>
              {kind === "knowledge" ? "Knowledge" : (title(revision) ?? "Note")}
              revision {revision.revision}
            </h3>
            {#if revision.revision === revisions[0]?.revision}
              <Badge tone="success">Current</Badge>
            {/if}
          </div>
          <p>{summary(revision)}</p>
        </div>
        <time datetime={revision.createdAt}>
          {new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(revision.createdAt))}
        </time>
      </header>

      <dl>
        <div>
          <dt>Digest</dt>
          <dd title={revision.bodyDigest}>{revision.bodyDigest.slice(0, 24)}…</dd>
        </div>
        <div>
          <dt>Base revision</dt>
          <dd>
            {revision.baseRevisionId
              ? `linked · ${revision.baseRevisionId}`
              : "Initial"}
          </dd>
        </div>
        <div>
          <dt>Author</dt>
          <dd>{revision.createdByActorType.replace("_", " ")}</dd>
        </div>
        {#if revision.createdByAgent}
          <div>
            <dt>Declared agent</dt>
            <dd>{revision.createdByAgent}</dd>
          </div>
          <div>
            <dt>Declared model</dt>
            <dd>{revision.createdByModel}</dd>
          </div>
        {/if}
      </dl>

      <div class="rendered">
        <SafeMarkdown source={body(revision)} />
      </div>

      <details>
        <summary>Exact Markdown source and learning metadata</summary>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (A named focusable scroll region lets keyboard users inspect exact revision source.) -->
        <pre
          tabindex="0"
          aria-label={`${kind} revision ${String(revision.revision)} source`}><code
            >{body(revision)}</code
          ></pre>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (A named focusable scroll region lets keyboard users inspect revision metadata.) -->
        <pre
          tabindex="0"
          aria-label={`${kind} revision ${String(revision.revision)} learning metadata`}><code
            >{JSON.stringify(revision.learningMetadata, null, 2)}</code
          ></pre>
      </details>
    </article>
  {/each}
</div>

<style>
  .history {
    display: grid;
    gap: var(--sp-space-4);
  }

  article {
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  article > header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: start;
    padding: var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .revision-mark {
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-space-2);
  }

  h3,
  p,
  dl,
  dt,
  dd {
    margin: 0;
  }

  h3 {
    font-size: var(--sp-font-size-4);
  }

  header p,
  time {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  time {
    white-space: nowrap;
  }

  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: var(--sp-space-3);
    padding: var(--sp-space-3) var(--sp-space-4);
    background: var(--sp-color-surface-muted);
  }

  dt {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    text-transform: uppercase;
  }

  dd {
    overflow-wrap: anywhere;
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
  }

  .rendered {
    padding: var(--sp-space-4);
  }

  details {
    border-top: 1px solid var(--sp-color-border);
    padding: var(--sp-space-3) var(--sp-space-4) var(--sp-space-4);
  }

  summary {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
    cursor: pointer;
  }

  pre {
    overflow: auto;
    max-height: 20rem;
    margin: var(--sp-space-3) 0 0;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-canvas);
    color: var(--sp-color-text-muted);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
    white-space: pre-wrap;
  }

  @media (max-width: 40rem) {
    article > header {
      grid-template-columns: auto minmax(0, 1fr);
    }

    time {
      grid-column: 2;
    }
  }
</style>
