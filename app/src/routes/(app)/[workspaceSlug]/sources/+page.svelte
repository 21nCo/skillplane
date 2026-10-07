<script lang="ts">
  import { apiRequest } from "$lib/api/client.js";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { Button, Input, Select, EmptyState } from "@skillplane/ui";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    sourceRequest,
    type Source,
    type SourceDetail,
    type Run,
  } from "$lib/sources/api.js";
  const store = useWorkspaceStore();
  const workspace = $derived(
    store.workspaces.find((w) => w.slug === page.params.workspaceSlug) ?? null,
  );
  const canManage = $derived(
    workspace?.role === "owner" || workspace?.role === "admin",
  );
  let sources = $state<Source[]>([]),
    selected = $state<SourceDetail | null>(null),
    preview = $state<Run | null>(null),
    cursor = $state<string | null>(null),
    loaded = $state("");
  let repositoryUrl = $state(""),
    ref = $state("HEAD"),
    refPolicy = $state("track"),
    path = $state(""),
    singlePath = $state(false),
    busy = $state(false),
    error = $state("");
  let bindPath = $state(""),
    bindSkillId = $state("");
  let available = $state<{ id: string; name: string; slug: string }[]>([]),
    bindQuery = $state("");
  let creationKey = crypto.randomUUID();
  function current(id: string) {
    return workspace?.id === id;
  }
  async function load(more = false) {
    if (!workspace) return;
    const id = workspace.id;
    const r = await sourceRequest<{ sources: Source[]; nextCursor: string | null }>(
      id,
      more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : "",
    );
    if (!current(id)) return;
    sources = more ? [...sources, ...r.sources] : r.sources;
    cursor = r.nextCursor;
  }
  async function detail(source: Source) {
    if (!workspace) return;
    const id = workspace.id;
    const r = await sourceRequest<SourceDetail>(
      id,
      `/${encodeURIComponent(source.id)}`,
    );
    if (!current(id)) return;
    selected = r;
    preview = null;
    repositoryUrl = r.source.repositoryUrl;
    ref = r.source.ref;
    refPolicy = r.source.refPolicy;
    singlePath = r.source.path !== null;
    path = r.source.path ?? "";
    bindPath = r.source.path ?? "";
    bindSkillId = "";
    if (canManage) await findSkills();
  }
  async function run(action: () => Promise<void>) {
    if (busy || !workspace) return;
    const id = workspace.id;
    busy = true;
    error = "";
    try {
      await action();
    } catch (e) {
      if (current(id)) error = e instanceof Error ? e.message : "The request failed";
    } finally {
      if (current(id)) busy = false;
    }
  }
  function config() {
    return { repositoryUrl, ref, refPolicy, path: singlePath ? path : null };
  }
  async function save(
    archived = Boolean(selected?.source.archivedAt),
    lifecycleOnly = false,
  ) {
    if (!workspace) return;
    const id = workspace.id;
    const r = await sourceRequest<{ source: Source }>(
      id,
      selected ? `/${encodeURIComponent(selected.source.id)}` : "",
      selected ? "PATCH" : "POST",
      {
        ...(lifecycleOnly && selected
          ? {
              repositoryUrl: selected.source.repositoryUrl,
              ref: selected.source.ref,
              refPolicy: selected.source.refPolicy,
              path: selected.source.path,
            }
          : config()),
        ...(selected ? { archived, expectedRevision: selected.source.revision } : {}),
      },
      creationKey,
    );
    if (!current(id)) return;
    creationKey = crypto.randomUUID();
    await load();
    await detail(r.source);
  }
  function selectedSource(id: string) {
    return selected?.source.id === id;
  }
  async function previewSource() {
    if (!workspace || !selected) return;
    const w = workspace.id,
      s = selected.source.id;
    const r = await sourceRequest<Run>(w, `/${encodeURIComponent(s)}/preview`, "POST");
    if (current(w) && selectedSource(s)) preview = r;
  }
  async function apply() {
    if (!workspace || !selected || !preview) return;
    const w = workspace.id,
      s = selected.source.id;
    const result = await sourceRequest<Run>(
      w,
      `/${encodeURIComponent(s)}/apply`,
      "POST",
      { runId: preview.id },
    );
    if (!current(w)) return;
    const source = selected.source;
    await load();
    await detail(source);
    preview = result;
  }
  async function findSkills() {
    if (!workspace) return;
    const id = workspace.id;
    const result = await apiRequest<{
      skills: { id: string; name: string; slug: string }[];
    }>(
      `/api/v1/workspaces/${encodeURIComponent(id)}/skills?q=${encodeURIComponent(bindQuery)}&limit=100`,
    );
    if (current(id)) available = result.skills;
  }
  async function disconnect(path: string) {
    if (!workspace || !selected) return;
    const w = workspace.id,
      s = selected.source;
    await sourceRequest(w, `/${encodeURIComponent(s.id)}/bindings`, "DELETE", { path });
    if (current(w)) await detail(s);
  }
  async function bind() {
    if (!workspace || !selected) return;
    await sourceRequest(
      workspace.id,
      `/${encodeURIComponent(selected.source.id)}/bindings`,
      "POST",
      { path: bindPath, skillId: bindSkillId },
    );
    await detail(selected.source);
  }
  $effect(() => {
    if (workspace && loaded !== workspace.id) {
      loaded = workspace.id;
      sources = [];
      selected = null;
      preview = null;
      error = "";
      busy = false;
      cursor = null;
      bindQuery = "";
      repositoryUrl = "";
      ref = "HEAD";
      refPolicy = "track";
      path = "";
      singlePath = false;
      bindPath = "";
      bindSkillId = "";
      available = [];
      creationKey = crypto.randomUUID();
      const id = workspace.id;
      void load().catch((e: unknown) => {
        if (current(id))
          error = e instanceof Error ? e.message : "Sources could not be loaded";
      });
    }
  });
</script>

<svelte:head><title>Git sources · {workspace?.name ?? "Skillplane"}</title></svelte:head
>
<!-- eslint-disable svelte/no-navigation-without-resolve -- dynamic external GitHub links; internal links use resolve -->
<main class="sources-page">
  <h1>Git sources</h1>
  <p>
    Connect public GitHub repositories to import one skill directory or every discovered
    skill. Preview the commit before applying changes.
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if canManage}<Button
      variant="secondary"
      disabled={busy}
      onclick={() => {
        selected = null;
        preview = null;
        repositoryUrl = "";
        ref = "HEAD";
        refPolicy = "track";
        path = "";
        singlePath = false;
        creationKey = crypto.randomUUID();
      }}>New source</Button
    >{/if}
  <nav aria-label="Git sources">
    {#each sources as source (source.id)}<Button
        variant="secondary"
        disabled={busy}
        onclick={() => void run(() => detail(source))}
        >{source.repositoryUrl.replace("https://github.com/", "")}
        {source.path ?? "(all skills)"}{source.archivedAt ? " · archived" : ""}</Button
      >{/each}
  </nav>
  {#if cursor}<Button disabled={busy} onclick={() => void run(() => load(true))}
      >Load more sources</Button
    >{/if}
  {#if !sources.length}<EmptyState
      title="No Git sources"
      description="Add a public repository containing SKILL.md files."
    />{/if}
  {#if canManage}<form
      onsubmit={(e) => {
        e.preventDefault();
        void run(() => save());
      }}
    >
      <h2>{selected ? "Source settings" : "Add source"}</h2>
      <Input
        label="Repository URL"
        bind:value={repositoryUrl}
        placeholder="https://github.com/owner/repository"
        required
        readonly={Boolean(selected)}
      />
      <Select
        label="Ref policy"
        bind:value={refPolicy}
        options={[
          { value: "track", label: "Track a branch or tag (manual sync)" },
          { value: "pin", label: "Pin an immutable commit" },
        ]}
      />
      <Input label="Branch, tag, or commit" bind:value={ref} required />
      <label
        ><input
          type="checkbox"
          bind:checked={singlePath}
          disabled={Boolean(selected)}
        /> Import a single skill path</label
      >
      {#if singlePath}<Input
          label="SKILL.md path or skill directory"
          bind:value={path}
          readonly={Boolean(selected)}
          placeholder="skills/review/SKILL.md (empty for repository root)"
        />{/if}
      <Button type="submit" disabled={busy}>Save source</Button>
      {#if selected}<Button
          variant="secondary"
          disabled={busy}
          onclick={() => void run(() => save(!selected?.source.archivedAt, true))}
          >{selected.source.archivedAt ? "Restore source" : "Archive source"}</Button
        >{/if}
    </form>{/if}
  {#if selected}
    <section>
      <h2>Source detail</h2>
      <p>
        <a href={selected.source.repositoryUrl} target="_blank" rel="noreferrer"
          >{selected.source.repositoryUrl}</a
        >
        · {selected.source.refPolicy} · {selected.source.ref}
      </p>
      {#if canManage && !selected.source.archivedAt}<Button
          disabled={busy}
          onclick={() => void run(previewSource)}>Preview sync</Button
        >{/if}
      <h3>Bound skills</h3>
      <ul>
        {#each selected.bindings as binding (binding.path)}<li>
            <a
              href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]", {
                workspaceSlug: workspace?.slug ?? "",
                skillSlug: binding.slug,
              })}>{binding.name}</a
            >
            · <code>{binding.path || "/"}</code> · {binding.status}{#if canManage && !binding.disconnectedAt}<Button
                variant="ghost"
                disabled={busy}
                onclick={() => void run(() => disconnect(binding.path))}
                >Disconnect binding</Button
              >{/if}{#if binding.lastCommitSha}<a
                href={`${selected.source.repositoryUrl}/commit/${binding.lastCommitSha}`}
                target="_blank"
                rel="noreferrer">{binding.lastCommitSha.slice(0, 12)}</a
              >{/if}
          </li>{/each}
      </ul>
      {#if canManage && !selected.source.archivedAt}<details>
          <summary>Bind an existing workspace skill</summary>
          <p>
            Manual skills are linked only through this explicit action. Choose a
            workspace skill and its source directory.
          </p>
          <form
            onsubmit={(e) => {
              e.preventDefault();
              void run(bind);
            }}
          >
            <Input label="Source path" bind:value={bindPath} /><Input
              label="Find existing skills"
              bind:value={bindQuery}
            /><Button
              variant="secondary"
              type="button"
              disabled={busy}
              onclick={() => void run(findSkills)}>Find skills</Button
            ><Select
              label="Existing workspace skill"
              bind:value={bindSkillId}
              options={[
                { value: "", label: "Choose a skill" },
                ...available.map((s) => ({
                  value: s.id,
                  label: `${s.name} (${s.slug})`,
                })),
              ]}
            /><Button type="submit" disabled={busy || !bindSkillId}>Bind skill</Button>
          </form>
        </details>{/if}
      <h3>Recent syncs</h3>
      <ul>
        {#each selected.runs as item (item.id)}<li>
            {item.createdAt} · {item.status} ·
            <a
              href={`${selected.source.repositoryUrl}/commit/${item.commitSha}`}
              target="_blank"
              rel="noreferrer">{item.commitSha.slice(0, 12)}</a
            ><Button variant="ghost" disabled={busy} onclick={() => (preview = item)}
              >View preview and results</Button
            >
          </li>{/each}
      </ul>
    </section>{/if}
  {#if preview && selected}<section aria-label="Sync preview">
      <h2>Sync preview</h2>
      {#if preview.failureMessage}<p role="status">{preview.failureMessage}</p>{/if}
      <p>
        Commit <a
          href={`${selected.source.repositoryUrl}/commit/${preview.commitSha}`}
          target="_blank"
          rel="noreferrer">{preview.commitSha}</a
        >
      </p>
      <p>
        New skills are private. Existing skill changes become candidates for review.
        Missing or renamed paths preserve existing skills.
      </p>
      <table>
        <thead
          ><tr><th>Path</th><th>Skill</th><th>Action</th><th>Details</th></tr></thead
        ><tbody
          >{#each preview.plan as item (item.path)}<tr
              ><td><code>{item.path || "/"}</code></td><td
                >{item.slug ?? "Invalid skill"}</td
              ><td>{item.action}</td><td>{item.message ?? ""}</td></tr
            >{/each}</tbody
        >
      </table>
      {#if canManage && !selected.source.archivedAt && preview.status !== "complete"}<Button
          disabled={busy || !preview.plan.length}
          onclick={() => void run(apply)}
          >{preview.status === "partial"
            ? "Retry failed imports"
            : "Apply this preview"}</Button
        >{/if}
      {#if preview.results.length}<h3>Sync results</h3>
        <ul>
          {#each preview.results as result (result.path)}<li>
              {result.path || "/"} · {result.status}
              {result.message ?? ""}
            </li>{/each}
        </ul>{/if}
    </section>{/if}
</main>

<!-- eslint-enable svelte/no-navigation-without-resolve -->

<style>
  .sources-page {
    display: grid;
    gap: 1rem;
    max-width: 70rem;
    padding: 2rem;
  }
  form,
  section {
    display: grid;
    gap: 1rem;
  }
  nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  table {
    width: 100%;
    text-align: left;
    border-collapse: collapse;
  }
  td,
  th {
    padding: 0.75rem;
    border-bottom: 1px solid var(--sp-border-default);
  }
  li {
    margin: 0.5rem 0;
    overflow-wrap: anywhere;
  }
  @media (max-width: 640px) {
    .sources-page {
      padding: 1rem;
    }
    table {
      display: block;
      overflow: auto;
    }
  }
</style>
