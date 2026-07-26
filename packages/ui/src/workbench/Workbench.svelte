<script lang="ts">
  import {
    ArchiveIcon,
    DotsThreeIcon,
    FolderOpenIcon,
    GearIcon,
    PlusIcon,
    ShieldCheckIcon,
  } from "phosphor-svelte";
  import Badge from "../components/Badge.svelte";
  import Button from "../components/Button.svelte";
  import CommandMenu, { type CommandItem } from "../components/CommandMenu.svelte";
  import DataTable, { type DataTableColumn } from "../components/DataTable.svelte";
  import Dialog from "../components/Dialog.svelte";
  import Dropdown, { type DropdownItem } from "../components/Dropdown.svelte";
  import EmptyState from "../components/EmptyState.svelte";
  import ErrorState from "../components/ErrorState.svelte";
  import IconButton from "../components/IconButton.svelte";
  import Input from "../components/Input.svelte";
  import Select from "../components/Select.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Tabs from "../components/Tabs.svelte";
  import Textarea from "../components/Textarea.svelte";
  import Toast from "../components/Toast.svelte";
  import {
    DENSITIES,
    THEMES,
    applyAppearance,
    type Density,
    type Theme,
  } from "../theme.js";
  import { onMount } from "svelte";

  interface SkillRow extends Record<string, unknown> {
    name: string;
    version: string;
    visibility: string;
    updated: string;
  }

  let theme = $state<Theme>("dark");
  let density = $state<Density>("compact");
  let inputValue = $state("pr-review");
  let invalidValue = $state("");
  let description = $state(
    "Review pull requests with repository-specific context and a consistent rubric.",
  );
  let visibility = $state("workspace");
  let dialogOpen = $state(false);
  let commandOpen = $state(false);
  let destructiveOpen = $state(false);
  let toastVisible = $state(true);
  let selectedTab = $state("overview");
  let selectedAction = $state("publish");

  const rows: readonly SkillRow[] = [
    {
      name: "PR review",
      version: "1.4.2",
      visibility: "Workspace",
      updated: "2 minutes ago",
    },
    {
      name: "Incident analysis",
      version: "2.1.0",
      visibility: "Private",
      updated: "Yesterday",
    },
    {
      name: "Release notes",
      version: "1.0.7",
      visibility: "Public",
      updated: "Jul 24",
    },
  ];
  const columns: readonly DataTableColumn<SkillRow>[] = [
    { id: "name", label: "Skill", sortable: true, value: (row) => row.name },
    { id: "version", label: "Version", value: (row) => row.version },
    { id: "visibility", label: "Visibility", value: (row) => row.visibility },
    {
      id: "updated",
      label: "Updated",
      align: "end",
      sortable: true,
      value: (row) => row.updated,
    },
  ];
  const dropdownItems: readonly DropdownItem[] = [
    { id: "publish", label: "Publish version", description: "Create a release" },
    { id: "archive", label: "Archive skill", description: "History is preserved" },
    {
      id: "delete",
      label: "Delete draft",
      description: "Only unused drafts can be deleted",
      danger: true,
      disabled: true,
    },
  ];
  const commands: readonly CommandItem[] = [
    {
      id: "new-skill",
      label: "Create a skill",
      group: "Actions",
      keywords: ["new", "bundle"],
      shortcut: "C S",
      icon: PlusIcon,
      run: () => {
        dialogOpen = true;
      },
    },
    {
      id: "settings",
      label: "Open workspace settings",
      group: "Navigate",
      icon: GearIcon,
      run: () => {
        toastVisible = true;
      },
    },
    {
      id: "rotate",
      label: "Rotate agent credential",
      group: "Security",
      icon: ShieldCheckIcon,
      disabledReason: "Owner permission required",
      run: () => undefined,
    },
  ];

  function setTheme(next: Theme) {
    theme = next;
    applyAppearance(theme, density);
  }

  function setDensity(next: Density) {
    density = next;
    applyAppearance(theme, density);
  }

  onMount(() => {
    const parameters = new URLSearchParams(location.search);
    const requestedTheme = parameters.get("theme");
    const requestedDensity = parameters.get("density");
    theme = requestedTheme === "light" ? "light" : "dark";
    density = requestedDensity === "comfortable" ? "comfortable" : "compact";
    applyAppearance(theme, density);
  });
</script>

<svelte:head><title>Skillplane UI workbench</title></svelte:head>

<header class="workbench-header">
  <div>
    <span class="mark" aria-hidden="true">S</span>
    <div>
      <strong>Skillplane UI</strong>
      <small>Component workbench</small>
    </div>
  </div>
  <nav aria-label="Workbench controls">
    <Select
      label="Theme"
      options={THEMES.map((item) => ({ value: item, label: item }))}
      value={theme}
      onchange={(event) => setTheme(event.currentTarget.value as Theme)}
    />
    <Select
      label="Density"
      options={DENSITIES.map((item) => ({ value: item, label: item }))}
      value={density}
      onchange={(event) => setDensity(event.currentTarget.value as Density)}
    />
    <Button variant="secondary" size="sm" onclick={() => (commandOpen = true)}>
      Commands
      {#snippet trailing()}<kbd>⌘K</kbd>{/snippet}
    </Button>
  </nav>
</header>

<main>
  <section class="intro" aria-labelledby="workbench-title">
    <div>
      <Badge tone="accent">System v1</Badge>
      <h1 id="workbench-title">Compact controls for high-trust agent workflows.</h1>
      <p>
        Semantic tokens, visible focus, resilient states, and restrained motion across
        every Skillplane surface.
      </p>
    </div>
    <div class="intro-actions">
      <Button variant="primary" onclick={() => (dialogOpen = true)}>
        {#snippet leading()}<PlusIcon size={16} weight="bold" />{/snippet}
        New skill
      </Button>
      <Dropdown
        label="Actions"
        items={dropdownItems}
        selectedId={selectedAction}
        align="end"
        onSelect={(item) => {
          selectedAction = item.id;
          if (item.id === "archive") destructiveOpen = true;
        }}
      />
      <IconButton label="More options" variant="secondary">
        <DotsThreeIcon weight="bold" />
      </IconButton>
    </div>
  </section>

  <section class="workbench-section" aria-labelledby="controls-title">
    <div class="section-heading">
      <div>
        <span>Primitives</span>
        <h2 id="controls-title">Controls and validation</h2>
      </div>
      <Badge>Keyboard ready</Badge>
    </div>
    <div class="control-grid">
      <div class="field-stack">
        <Input
          label="Skill slug"
          description="Used in MCP tool arguments and public URLs."
          bind:value={inputValue}
        />
        <Input
          label="Required owner"
          placeholder="person@example.com"
          bind:value={invalidValue}
          error="Choose an active workspace member."
        />
      </div>
      <div class="field-stack">
        <Textarea
          label="Description"
          description="Explain when an agent should retrieve this skill."
          bind:value={description}
        />
        <Select
          label="Visibility"
          bind:value={visibility}
          options={[
            { value: "private", label: "Private" },
            { value: "workspace", label: "Workspace" },
            { value: "public", label: "Public" },
          ]}
        />
      </div>
    </div>
    <div class="button-row" aria-label="Button variants">
      <Button variant="primary">Publish version</Button>
      <Button variant="secondary">Save draft</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="danger" onclick={() => (destructiveOpen = true)}>Archive</Button>
      <Button loading>Validating</Button>
      <Button disabled title="A change is required before saving">No changes</Button>
    </div>
  </section>

  <section class="workbench-section" aria-labelledby="data-title">
    <div class="section-heading">
      <div>
        <span>Data display</span>
        <h2 id="data-title">Skill inventory</h2>
      </div>
      <div class="badge-row">
        <Badge tone="success">Published</Badge>
        <Badge tone="warning">Review</Badge>
        <Badge tone="danger">Failed</Badge>
      </div>
    </div>
    <DataTable
      label="Skills"
      {rows}
      {columns}
      rowKey={(row) => row.name}
      onSort={() => (toastVisible = true)}
    >
      {#snippet rowActions()}
        <IconButton label="Open row actions"><DotsThreeIcon weight="bold" /></IconButton
        >
      {/snippet}
    </DataTable>
  </section>

  <section class="workbench-section" aria-labelledby="tabs-title">
    <div class="section-heading">
      <div>
        <span>Navigation</span>
        <h2 id="tabs-title">Tabs and states</h2>
      </div>
    </div>
    <Tabs
      label="Skill detail sections"
      bind:value={selectedTab}
      tabs={[
        { id: "overview", label: "Overview" },
        { id: "versions", label: "Versions", badge: "12" },
        { id: "contexts", label: "Contexts", badge: "4" },
        { id: "audit", label: "Audit" },
      ]}
    >
      {#snippet children(active)}
        <p class="tab-copy">
          {active === "overview"
            ? "A focused overview of the current release and its operational status."
            : `${String(active)} content is selected and keyboard reachable.`}
        </p>
      {/snippet}
    </Tabs>
    <div class="state-grid">
      <EmptyState
        title="No contexts yet"
        description="Create a context to retain project-specific knowledge without changing the base skill."
      >
        {#snippet icon()}<FolderOpenIcon weight="duotone" />{/snippet}
        {#snippet action()}<Button size="sm" variant="secondary">Create context</Button
          >{/snippet}
      </EmptyState>
      <ErrorState
        title="Bundle validation failed"
        description="The declared digest did not match the uploaded file."
        requestId="req_demo_7H4K"
        retry={() => (toastVisible = true)}
      />
      <ErrorState
        title="Owner access required"
        description="Your editor role can inspect this skill, but only a workspace owner can change its visibility."
      />
      <div class="skeleton-card" aria-label="Loading state">
        <Skeleton width="2.25rem" height="2.25rem" radius="var(--sp-radius-lg)" />
        <Skeleton width="62%" height="0.875rem" />
        <Skeleton width="90%" height="0.65rem" />
        <Skeleton width="74%" height="0.65rem" />
      </div>
    </div>
  </section>
</main>

{#if toastVisible}
  <div class="toast-region" aria-label="Notifications">
    <Toast
      tone="success"
      title="Version 1.4.2 published"
      message="The release pointer and audit event were committed."
      duration={null}
      onDismiss={() => (toastVisible = false)}
    />
  </div>
{/if}

<Dialog
  title="Create a skill"
  description="Start with a portable skill bundle. You can add contexts after creation."
  bind:open={dialogOpen}
>
  <div class="dialog-form">
    <Input label="Name" value="PR review" data-autofocus />
    <Select
      label="Initial visibility"
      options={[
        { value: "private", label: "Private" },
        { value: "workspace", label: "Workspace" },
      ]}
      value="workspace"
    />
  </div>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (dialogOpen = false)}>Cancel</Button>
    <Button variant="primary" onclick={() => (dialogOpen = false)}>Create skill</Button>
  {/snippet}
</Dialog>

<Dialog
  title="Archive this skill?"
  description="The skill leaves active search, but every version, context, note, and audit event is preserved."
  bind:open={destructiveOpen}
>
  <p class="dialog-warning">
    Existing agents cannot retrieve the skill after archival. You can restore it later.
  </p>
  {#snippet footer()}
    <Button variant="ghost" onclick={() => (destructiveOpen = false)}
      >Keep active</Button
    >
    <Button variant="danger" onclick={() => (destructiveOpen = false)}>
      {#snippet leading()}<ArchiveIcon size={16} />{/snippet}
      Archive skill
    </Button>
  {/snippet}
</Dialog>

<CommandMenu {commands} bind:open={commandOpen} />

<style>
  .workbench-header {
    position: sticky;
    z-index: 10;
    top: 0;
    display: flex;
    min-height: var(--sp-topbar-height);
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-4);
    padding: var(--sp-space-2) var(--sp-space-5);
    border-bottom: 1px solid var(--sp-color-border);
    background: color-mix(in srgb, var(--sp-color-canvas) 92%, transparent);
    backdrop-filter: blur(14px);
  }

  .workbench-header > div,
  .workbench-header nav {
    display: flex;
    align-items: center;
    gap: var(--sp-space-3);
  }

  .workbench-header nav {
    align-items: end;
  }

  .workbench-header nav :global(label) {
    margin-bottom: var(--sp-space-1);
    font-size: var(--sp-font-size-1);
  }

  .workbench-header nav :global(select) {
    min-width: 7rem;
  }

  .mark {
    display: grid;
    width: 1.75rem;
    height: 1.75rem;
    place-items: center;
    border: 1px solid var(--sp-color-accent);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
  }

  .workbench-header strong,
  .workbench-header small {
    display: block;
  }

  .workbench-header strong {
    font-size: var(--sp-font-size-3);
  }

  .workbench-header small {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  kbd {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-sm);
    padding: 1px var(--sp-space-1);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-sans);
    font-size: var(--sp-font-size-1);
  }

  main {
    width: min(calc(100% - var(--sp-space-8)), 72rem);
    margin: 0 auto;
    padding: var(--sp-space-10) 0 var(--sp-space-16);
  }

  .intro {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--sp-space-8);
    padding-bottom: var(--sp-space-8);
  }

  .intro h1 {
    max-width: 44rem;
    margin: var(--sp-space-3) 0 0;
    font-size: clamp(1.75rem, 5vw, 2.5rem);
    line-height: 1.05;
    letter-spacing: -0.045em;
  }

  .intro p,
  .tab-copy {
    max-width: 42rem;
    margin: var(--sp-space-3) 0 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-4);
    line-height: var(--sp-line-normal);
  }

  .intro-actions,
  .button-row,
  .badge-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    align-items: center;
  }

  .workbench-section {
    margin-top: var(--sp-space-6);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-xl);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
    box-shadow: var(--sp-shadow-sm);
  }

  .section-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
    margin-bottom: var(--sp-space-5);
  }

  .section-heading span,
  .section-heading h2 {
    display: block;
    margin: 0;
  }

  .section-heading > div > span {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .section-heading h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-5);
  }

  .control-grid,
  .state-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-5);
  }

  .field-stack {
    display: grid;
    align-content: start;
    gap: var(--sp-space-4);
  }

  .button-row {
    margin-top: var(--sp-space-5);
    padding-top: var(--sp-space-4);
    border-top: 1px solid var(--sp-color-border);
  }

  .state-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    margin-top: var(--sp-space-5);
  }

  .skeleton-card {
    display: grid;
    align-content: start;
    gap: var(--sp-space-3);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface-muted);
  }

  .toast-region {
    position: fixed;
    z-index: var(--sp-z-toast);
    right: var(--sp-space-4);
    bottom: var(--sp-space-4);
  }

  .dialog-form {
    display: grid;
    gap: var(--sp-space-4);
  }

  .dialog-warning {
    margin: 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  @media (max-width: 48rem) {
    .workbench-header {
      align-items: flex-start;
      padding: var(--sp-space-3);
    }

    .workbench-header nav {
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .workbench-header nav :global(.select-wrap),
    .workbench-header nav :global(label) {
      display: none;
    }

    main {
      width: min(calc(100% - var(--sp-space-4)), 72rem);
      padding-top: var(--sp-space-6);
    }

    .intro {
      display: grid;
      align-items: start;
    }

    .control-grid,
    .state-grid {
      grid-template-columns: minmax(0, 1fr);
    }

    .section-heading {
      align-items: flex-start;
    }

    .toast-region {
      right: var(--sp-space-2);
      bottom: var(--sp-space-2);
    }
  }
</style>
