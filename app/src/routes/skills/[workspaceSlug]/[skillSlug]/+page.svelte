<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, BrandMark, Button, SafeMarkdown } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { getPublicSkill, getPublicSkillFile } from "$lib/skills/api.js";
  import type { PublicSkill } from "$lib/skills/types.js";
  import {
    ArrowSquareOutIcon,
    BookOpenTextIcon,
    CheckCircleIcon,
    CubeIcon,
  } from "phosphor-svelte";

  let resource = $state<PublicSkill | null>(null);
  let markdown = $state("");
  let loading = $state(true);
  let error = $state<string | null>(null);
  let loadedKey = $state<string | null>(null);

  async function load() {
    const workspaceSlug = page.params.workspaceSlug;
    const skillSlug = page.params.skillSlug;
    if (!workspaceSlug || !skillSlug) {
      loading = false;
      error = "The public skill URL is incomplete.";
      return;
    }
    loading = true;
    error = null;
    try {
      const publicSkill = await getPublicSkill(workspaceSlug, skillSlug);
      const response = await getPublicSkillFile({
        skillId: publicSkill.skill.id,
        versionId: publicSkill.version.id,
        path: "SKILL.md",
      });
      resource = publicSkill;
      markdown = await response.text();
    } catch (cause) {
      resource = null;
      markdown = "";
      error =
        cause instanceof Error
          ? cause.message
          : "This public skill could not be loaded.";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const workspaceSlug = page.params.workspaceSlug;
    const skillSlug = page.params.skillSlug;
    if (!workspaceSlug || !skillSlug) return;
    const key = `${workspaceSlug}:${skillSlug}`;
    if (loadedKey !== key) {
      loadedKey = key;
      void load();
    }
  });
</script>

<svelte:head>
  <title>{resource?.skill.name ?? "Public skill"} · Skillplane</title>
  <meta
    name="description"
    content={resource?.skill.description ??
      "A versioned agent skill published on Skillplane."}
  />
</svelte:head>

<div class="public-shell">
  <header class="site-header">
    <a class="brand" href={resolve("/")}>
      <BrandMark />
      <strong>Skillplane</strong>
    </a>
    <Button variant="secondary" size="sm" href={resolve("/sign-in")}>Sign in</Button>
  </header>

  <main>
    {#if loading}
      <SkillState
        kind="loading"
        title="Loading published skill"
        message="Verifying the current immutable version."
      />
    {:else if error !== null || !resource}
      <SkillState
        kind="error"
        title="Public skill unavailable"
        message={error ??
          "The skill may be private, archived, unpublished, or no longer available."}
        retry={() => void load()}
      />
    {:else}
      <header class="skill-header">
        <div class="skill-icon" aria-hidden="true">
          <BookOpenTextIcon weight="duotone" />
        </div>
        <div class="heading-copy">
          <div class="eyebrow">
            <span>{page.params.workspaceSlug}</span>
            <span aria-hidden="true">/</span>
            <code>{resource.skill.slug}</code>
          </div>
          <h1>{resource.skill.name}</h1>
          <p>{resource.skill.description || "No description provided."}</p>
          <div class="badges">
            <Badge tone="success">Public</Badge>
            <Badge tone="info">v{resource.version.semanticVersion}</Badge>
            <Badge tone="neutral">
              Immutable revision {resource.version.revision}
            </Badge>
          </div>
        </div>
      </header>

      <section class="trust-strip" aria-label="Published skill details">
        <div>
          <CheckCircleIcon weight="fill" aria-hidden="true" />
          <span>
            <strong>Published version</strong>
            Exact content identified by its digest
          </span>
        </div>
        <div>
          <CubeIcon weight="duotone" aria-hidden="true" />
          <span>
            <strong>{resource.version.manifest.fileCount} files</strong>
            {resource.version.byteSize.toLocaleString()} byte bundle
          </span>
        </div>
        <div>
          <ArrowSquareOutIcon weight="duotone" aria-hidden="true" />
          <span>
            <strong>Agent ready</strong>
            Retrievable through Skillplane MCP
          </span>
        </div>
      </section>

      <article>
        <SafeMarkdown source={markdown} />
      </article>

      <footer class="digest">
        <span>Content digest</span>
        <code>{resource.version.digest}</code>
      </footer>
    {/if}
  </main>
</div>

<style>
  .public-shell {
    min-height: 100dvh;
    background:
      radial-gradient(
        circle at 50% -8rem,
        var(--sp-color-accent-soft),
        transparent 30rem
      ),
      var(--sp-color-surface);
  }

  .site-header {
    display: flex;
    width: min(calc(100% - var(--sp-space-8)), 72rem);
    min-height: var(--sp-topbar-height);
    align-items: center;
    justify-content: space-between;
    margin: 0 auto;
    border-bottom: 1px solid var(--sp-color-border);
  }

  .brand {
    display: inline-flex;
    gap: var(--sp-space-2);
    align-items: center;
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-3);
    text-decoration: none;
  }

  main {
    width: min(calc(100% - var(--sp-space-8)), 58rem);
    margin: 0 auto;
    padding: var(--sp-space-12) 0 var(--sp-space-16);
  }

  .skill-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-4);
  }

  .skill-icon {
    display: grid;
    width: 3rem;
    height: 3rem;
    place-items: center;
    border: 1px solid var(--sp-color-accent);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .heading-copy h1,
  .heading-copy p {
    margin: 0;
  }

  .heading-copy h1 {
    margin-top: var(--sp-space-2);
    font-size: clamp(2rem, 6vw, 3.25rem);
    letter-spacing: -0.05em;
    line-height: 1;
  }

  .heading-copy > p {
    max-width: 44rem;
    margin-top: var(--sp-space-3);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-4);
    line-height: var(--sp-line-normal);
  }

  .eyebrow,
  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    align-items: center;
  }

  .eyebrow {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  code {
    font-family: var(--sp-font-mono);
  }

  .badges {
    margin-top: var(--sp-space-4);
  }

  .trust-strip {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin-top: var(--sp-space-8);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface-raised);
  }

  .trust-strip > div {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-2);
    align-items: start;
    padding: var(--sp-space-3);
    color: var(--sp-color-accent-text);
  }

  .trust-strip > div + div {
    border-left: 1px solid var(--sp-color-border);
  }

  .trust-strip span,
  .trust-strip strong {
    display: block;
  }

  .trust-strip span {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    line-height: var(--sp-line-normal);
  }

  .trust-strip strong {
    color: var(--sp-color-text);
  }

  article {
    margin-top: var(--sp-space-6);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: clamp(var(--sp-space-4), 5vw, var(--sp-space-8));
    background: var(--sp-color-surface-raised);
  }

  .digest {
    display: grid;
    gap: var(--sp-space-1);
    margin-top: var(--sp-space-4);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .digest code {
    overflow-wrap: anywhere;
  }

  @media (max-width: 42rem) {
    .site-header,
    main {
      width: calc(100% - var(--sp-space-6));
    }

    main {
      padding-top: var(--sp-space-8);
    }

    .trust-strip {
      grid-template-columns: 1fr;
    }

    .trust-strip > div + div {
      border-top: 1px solid var(--sp-color-border);
      border-left: 0;
    }
  }

  @media (max-width: 25rem) {
    .skill-header {
      grid-template-columns: 1fr;
    }
  }
</style>
