<script lang="ts">
  import { resolve } from "$app/paths";
  import { SafeMarkdown } from "@skillplane/ui";
  import {
    ArrowLeftIcon as ArrowLeft,
    ArrowSquareOutIcon as ArrowSquareOut,
    CalendarBlankIcon as CalendarBlank,
    CheckCircleIcon as CheckCircle,
    ClockCounterClockwiseIcon as ClockCounterClockwise,
    FileTextIcon as FileText,
    FingerprintIcon as Fingerprint,
    PlugIcon as Plug,
    StackIcon as Stack,
  } from "phosphor-svelte";
  import { SITE_ORIGIN } from "$lib/content.js";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  const canonicalPath = $derived(
    `/skills/${encodeURIComponent(data.workspaceSlug)}/${encodeURIComponent(
      data.skill.slug,
    )}`,
  );
  const publishedAt = $derived(
    new Intl.DateTimeFormat("en", {
      dateStyle: "long",
      timeZone: "UTC",
    }).format(new Date(data.version.publishedAt)),
  );
  function formatDate(value: string): string {
    return new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(value));
  }
</script>

<svelte:head>
  <title>{data.skill.name} by {data.workspaceSlug} · Skillplane</title>
  <link rel="canonical" href={`${SITE_ORIGIN}${canonicalPath}`} />
  <meta name="description" content={data.skill.description} />
  <meta
    property="og:title"
    content={`${data.skill.name} by ${data.workspaceSlug} · Skillplane`}
  />
  <meta property="og:description" content={data.skill.description} />
  <meta property="og:url" content={`${SITE_ORIGIN}${canonicalPath}`} />
  <meta
    name="twitter:title"
    content={`${data.skill.name} by ${data.workspaceSlug} · Skillplane`}
  />
  <meta name="twitter:description" content={data.skill.description} />
</svelte:head>

<main id="main-content" class="skill-page">
  <nav class="breadcrumbs" aria-label="Breadcrumb">
    <a href={resolve("/skills")}
      ><ArrowLeft size={14} aria-hidden="true" /> Public skills</a
    >
    <span aria-hidden="true">/</span>
    <span>{data.workspaceSlug}</span>
    <span aria-hidden="true">/</span>
    <span aria-current="page">{data.skill.slug}</span>
  </nav>

  <header class="skill-header">
    <div class="skill-heading">
      <span class="skill-icon"
        ><Stack size={23} weight="duotone" aria-hidden="true" /></span
      >
      <div>
        <p class="workspace">{data.workspaceSlug}</p>
        <h1>{data.skill.name}</h1>
      </div>
    </div>
    <p class="description">{data.skill.description}</p>
    <div class="tags" aria-label="Skill tags">
      {#each data.skill.tags as tag (tag)}
        <span>{tag}</span>
      {/each}
    </div>
  </header>

  <div class="skill-layout">
    <div class="primary-column">
      <section class="content-panel" aria-labelledby="skill-content-title">
        <div class="panel-header">
          <div>
            <p>Published instructions</p>
            <h2 id="skill-content-title">SKILL.md</h2>
          </div>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
          <a href={data.contentUrl} target="_blank" rel="noreferrer">
            Raw file <ArrowSquareOut size={14} aria-hidden="true" />
          </a>
        </div>
        <div class="markdown-content">
          <SafeMarkdown source={data.markdown} />
        </div>
      </section>

      <section class="history" aria-labelledby="version-history-title">
        <div class="history-heading">
          <ClockCounterClockwise size={19} weight="duotone" aria-hidden="true" />
          <div>
            <h2 id="version-history-title">Published version history</h2>
            <p>Immutable versions available for this public skill.</p>
          </div>
        </div>
        <ol>
          {#each data.versions as version, index (version.id)}
            <li>
              <span class="timeline-marker" aria-hidden="true"></span>
              <div class="version-row">
                <div class="version-heading">
                  <strong>v{version.semanticVersion}</strong>
                  {#if index === 0}<span class="current">Current</span>{/if}
                  <time datetime={version.publishedAt}
                    >{formatDate(version.publishedAt)}</time
                  >
                </div>
                <p>{version.changeSummary}</p>
                <code>{version.digest.slice(0, 24)}…</code>
              </div>
            </li>
          {/each}
        </ol>
      </section>
    </div>

    <aside aria-label="Skill metadata">
      <section class="metadata-card">
        <h2>Published version</h2>
        <dl>
          <div>
            <dt><CheckCircle size={15} aria-hidden="true" /> Version</dt>
            <dd>v{data.version.semanticVersion}</dd>
          </div>
          <div>
            <dt><CalendarBlank size={15} aria-hidden="true" /> Published</dt>
            <dd>{publishedAt}</dd>
          </div>
          <div>
            <dt><FileText size={15} aria-hidden="true" /> Files</dt>
            <dd>{data.version.manifest.fileCount}</dd>
          </div>
          <div>
            <dt><Fingerprint size={15} aria-hidden="true" /> Digest</dt>
            <dd><code>{data.version.digest.slice(0, 20)}…</code></dd>
          </div>
        </dl>
      </section>

      <section class="mcp-card">
        <span><Plug size={20} weight="duotone" aria-hidden="true" /></span>
        <h2>Use it through MCP</h2>
        <p>
          Connect an agent, grant workspace access, and retrieve this skill with
          declared agent and model details.
        </p>
        <code>https://mcp.skillplane.dev/mcp</code>
        <a href="https://app.skillplane.dev/settings/agents">
          Connect an agent <ArrowSquareOut size={14} aria-hidden="true" />
        </a>
      </section>

      <p class="privacy-note">
        This page contains published skill content only. Context knowledge, notes,
        candidates, and audit records remain private.
      </p>
    </aside>
  </div>
</main>

<style>
  .skill-page {
    width: min(100% - 2rem, 75rem);
    margin: 0 auto;
    padding: var(--sp-space-8) 0 clamp(5rem, 9vw, 7rem);
  }

  .breadcrumbs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    align-items: center;
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .breadcrumbs a {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    text-decoration: none;
  }

  .skill-header {
    max-width: 54rem;
    padding: clamp(3rem, 7vw, 5.5rem) 0;
  }

  .skill-heading {
    display: flex;
    gap: var(--sp-space-4);
    align-items: center;
  }

  .skill-icon {
    display: grid;
    width: 3.25rem;
    height: 3.25rem;
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    box-shadow: var(--sp-shadow-sm);
  }

  .workspace {
    margin: 0 0 var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
  }

  h1 {
    margin: 0;
    font-size: clamp(2.5rem, 7vw, 5rem);
    letter-spacing: -0.06em;
    line-height: 0.95;
  }

  .description {
    max-width: 48rem;
    margin: var(--sp-space-5) 0 0;
    color: var(--sp-color-text-muted);
    font-size: clamp(1rem, 2vw, 1.2rem);
    line-height: 1.65;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    margin-top: var(--sp-space-5);
  }

  .tags span {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-round);
    padding: 0.3rem 0.6rem;
    background: var(--sp-color-surface);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  .skill-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 19rem;
    gap: var(--sp-space-6);
    align-items: start;
  }

  .primary-column {
    display: grid;
    min-width: 0;
    gap: var(--sp-space-6);
  }

  .content-panel,
  .history,
  .metadata-card,
  .mcp-card {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
    box-shadow: var(--sp-shadow-sm);
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
    padding: var(--sp-space-4) var(--sp-space-5);
  }

  .panel-header p {
    margin: 0 0 var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    text-transform: uppercase;
  }

  .panel-header h2 {
    margin: 0;
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-4);
  }

  .panel-header a,
  .mcp-card a {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-1);
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-medium);
    text-decoration: none;
  }

  .markdown-content {
    padding: clamp(1.5rem, 5vw, 3rem);
  }

  .history {
    padding: var(--sp-space-5);
  }

  .history-heading {
    display: flex;
    gap: var(--sp-space-3);
    align-items: flex-start;
    border-bottom: 1px solid var(--sp-color-border);
    padding-bottom: var(--sp-space-4);
    color: var(--sp-color-accent-text);
  }

  .history-heading h2 {
    margin: 0;
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-5);
  }

  .history-heading p {
    margin: var(--sp-space-1) 0 0;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .history ol {
    margin: 0;
    padding: var(--sp-space-4) 0 0;
    list-style: none;
  }

  .history li {
    position: relative;
    display: grid;
    grid-template-columns: 1rem 1fr;
    gap: var(--sp-space-3);
    padding-bottom: var(--sp-space-5);
  }

  .history li:not(:last-child)::before {
    position: absolute;
    top: 0.8rem;
    bottom: 0;
    left: 0.34rem;
    width: 1px;
    background: var(--sp-color-border);
    content: "";
  }

  .timeline-marker {
    z-index: 1;
    width: 0.7rem;
    height: 0.7rem;
    margin-top: 0.25rem;
    border: 2px solid var(--sp-color-accent);
    border-radius: 50%;
    background: var(--sp-color-surface);
  }

  .version-heading {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    align-items: center;
  }

  .version-heading strong {
    font-size: var(--sp-font-size-4);
  }

  .version-heading time {
    margin-left: auto;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .current {
    border-radius: var(--sp-radius-round);
    padding: 0.2rem 0.45rem;
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-semibold);
  }

  .version-row p {
    margin: var(--sp-space-2) 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  code {
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
    overflow-wrap: anywhere;
  }

  aside {
    position: sticky;
    top: 5rem;
    display: grid;
    gap: var(--sp-space-4);
  }

  .metadata-card,
  .mcp-card {
    padding: var(--sp-space-5);
  }

  aside h2 {
    margin: 0;
    font-size: var(--sp-font-size-4);
  }

  .metadata-card dl {
    margin: var(--sp-space-4) 0 0;
  }

  .metadata-card dl div {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-space-3);
    border-top: 1px solid var(--sp-color-border);
    padding: var(--sp-space-3) 0;
  }

  .metadata-card dt {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .metadata-card dd {
    margin: 0;
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-medium);
    text-align: right;
  }

  .mcp-card > span {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .mcp-card h2 {
    margin-top: var(--sp-space-4);
  }

  .mcp-card p {
    margin: var(--sp-space-2) 0 var(--sp-space-4);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    line-height: 1.6;
  }

  .mcp-card > code {
    display: block;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-sm);
    padding: var(--sp-space-2);
    background: var(--sp-color-canvas);
    color: var(--sp-color-text-muted);
  }

  .mcp-card a {
    margin-top: var(--sp-space-4);
  }

  .privacy-note {
    margin: 0;
    border-left: 2px solid var(--sp-color-border-strong);
    padding-left: var(--sp-space-3);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
    line-height: 1.55;
  }

  @media (max-width: 56rem) {
    .skill-layout {
      grid-template-columns: 1fr;
    }

    aside {
      position: static;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .privacy-note {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 38rem) {
    .skill-heading {
      align-items: flex-start;
    }

    .panel-header {
      align-items: flex-start;
      flex-direction: column;
    }

    aside {
      grid-template-columns: 1fr;
    }

    .privacy-note {
      grid-column: 1;
    }

    .version-heading time {
      width: 100%;
      margin-left: 0;
    }
  }
</style>
