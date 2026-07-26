<script lang="ts">
  import { Badge } from "@skillplane/ui";
  import type { LearningMetadata as Learning } from "./types.js";
  import {
    CheckCircleIcon,
    FlaskIcon,
    LightbulbIcon,
    LinkIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";

  let {
    metadata,
  }: {
    metadata: Learning | Readonly<Record<string, never>>;
  } = $props();

  const learning = $derived("summary" in metadata ? (metadata as Learning) : null);
  const hasExtra = $derived(
    Boolean(learning && Object.keys(learning.extra).length > 0),
  );
</script>

{#if learning}
  <div class="learning" data-testid="learning-metadata">
    <header>
      <div class="eyebrow"><LightbulbIcon weight="fill" /> Learning record</div>
      <div class="title-row">
        <h3>{learning.summary}</h3>
        <Badge
          tone={learning.confidence === "high"
            ? "success"
            : learning.confidence === "low"
              ? "warning"
              : "info"}
        >
          {learning.confidence} confidence
        </Badge>
      </div>
    </header>

    <div class="narrative">
      <section>
        <h4>Observation</h4>
        <p>{learning.observation}</p>
      </section>
      <section>
        <h4>Why this improves the skill</h4>
        <p>{learning.rationale}</p>
      </section>
    </div>

    <div class="evidence-grid">
      <section>
        <h4><LinkIcon weight="bold" /> Evidence</h4>
        {#if learning.evidence.length}
          <ul>
            {#each learning.evidence as evidence (`${evidence.kind}:${evidence.reference}`)}
              <li>
                <div><Badge tone="neutral">{evidence.kind}</Badge></div>
                <strong>{evidence.description}</strong>
                <code>{evidence.reference}</code>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="absence">
            <WarningCircleIcon weight="fill" />
            {learning.evidenceUnavailableReason}
          </p>
        {/if}
      </section>

      <section>
        <h4><FlaskIcon weight="bold" /> Validation</h4>
        {#if learning.validation.length}
          <ul>
            {#each learning.validation as validation (`${validation.kind}:${validation.description}`)}
              <li>
                <div>
                  <Badge
                    tone={validation.status === "passed"
                      ? "success"
                      : validation.status === "failed"
                        ? "danger"
                        : "warning"}
                  >
                    {validation.status.replace("_", " ")}
                  </Badge>
                </div>
                <strong>{validation.kind}</strong>
                <span>{validation.description}</span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="absence">
            <WarningCircleIcon weight="fill" />
            {learning.validationNotRunReason}
          </p>
        {/if}
      </section>
    </div>

    {#if learning.sourceContextId}
      <section class="context-source">
        <CheckCircleIcon weight="fill" />
        <div>
          <strong>Context-backed learning</strong>
          <p>
            Context <code>{learning.sourceContextId}</code> at revision
            <code>{learning.sourceContextRevisionId ?? "no knowledge revision"}</code>
          </p>
          {#if learning.sourceContextDigest}
            <code class="digest">{learning.sourceContextDigest}</code>
          {/if}
        </div>
      </section>
    {/if}

    {#if learning.tags.length || learning.externalReferences.length}
      <footer>
        {#if learning.tags.length}
          <div class="tags">
            {#each learning.tags as tag (tag)}
              <Badge tone="neutral">{tag}</Badge>
            {/each}
          </div>
        {/if}
        {#if learning.externalReferences.length}
          <div class="links">
            {#each learning.externalReferences as reference (reference.url)}
              <!-- This is an audited, user-supplied absolute external reference. -->
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
              <a href={reference.url} target="_blank" rel="noreferrer">
                {reference.label}<LinkIcon weight="bold" />
              </a>
            {/each}
          </div>
        {/if}
      </footer>
    {/if}

    {#if hasExtra}
      <details>
        <summary>Additional learning metadata</summary>
        <pre>{JSON.stringify(learning.extra, null, 2)}</pre>
      </details>
    {/if}
  </div>
{:else}
  <p class="empty">This version predates structured learning metadata.</p>
{/if}

<style>
  .learning {
    display: grid;
    gap: var(--sp-space-4);
  }

  header,
  h3,
  h4,
  p {
    margin: 0;
  }

  .eyebrow,
  h4 {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .eyebrow {
    color: var(--sp-color-accent-text);
  }

  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-2);
    margin-top: var(--sp-space-1);
  }

  h3 {
    font-size: var(--sp-font-size-5);
  }

  .narrative,
  .evidence-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-3);
  }

  .narrative section,
  .evidence-grid > section,
  .context-source {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface-raised);
  }

  .narrative p {
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-muted);
    line-height: var(--sp-line-relaxed);
    white-space: pre-wrap;
  }

  ul {
    display: grid;
    gap: var(--sp-space-2);
    margin: var(--sp-space-3) 0 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    gap: var(--sp-space-1);
    border-top: 1px solid var(--sp-color-border);
    padding-top: var(--sp-space-2);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  li:first-child {
    border-top: 0;
    padding-top: 0;
  }

  li strong {
    color: var(--sp-color-text);
  }

  code,
  pre {
    overflow-wrap: anywhere;
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .absence {
    display: flex;
    gap: var(--sp-space-2);
    align-items: flex-start;
    margin-top: var(--sp-space-3);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  .context-source {
    display: flex;
    gap: var(--sp-space-3);
    color: var(--sp-color-success);
  }

  .context-source p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  .digest {
    display: block;
    margin-top: var(--sp-space-1);
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--sp-space-3);
  }

  .tags,
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
  }

  .links a {
    display: inline-flex;
    gap: var(--sp-space-1);
    align-items: center;
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-2);
    text-decoration: none;
  }

  details {
    border-top: 1px solid var(--sp-color-border);
    padding-top: var(--sp-space-3);
  }

  summary {
    cursor: pointer;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  pre {
    overflow: auto;
    max-height: 18rem;
    margin: var(--sp-space-2) 0 0;
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface-muted);
  }

  .empty {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-3);
  }

  @media (max-width: 46rem) {
    .narrative,
    .evidence-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
