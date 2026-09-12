<script lang="ts">
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import { apiRequest } from "$lib/api/client.js";
  import { Button, Input, Select, Textarea } from "@skillplane/ui";
  export interface Dependency {
    alias: string;
    workspace: string;
    skill: string;
    version: string;
    scope: "execution" | "verification" | "both";
    mode: "include" | "invoke";
    required: boolean;
    order?: number;
  }
  let {
    workspaceId,
    dependencies = $bindable<Dependency[]>([]),
    verify = $bindable(false),
    verifier = $bindable(""),
    claims = $bindable("[]"),
    onchange = () => undefined,
  } = $props<{
    workspaceId: string;
    dependencies?: Dependency[];
    verify?: boolean;
    verifier?: string;
    claims?: string;
    onchange?: () => void;
  }>();
  let query = $state(""),
    searchScope = $state("workspace"),
    searching = $state(false),
    searchError = $state<string | null>(null);
  let matches = $state<
    {
      id: string;
      workspaceSlug: string;
      slug: string;
      name: string;
      semanticVersion: string;
    }[]
  >([]);
  async function search() {
    searching = true;
    searchError = null;
    try {
      const params = new SvelteURLSearchParams({ q: query, limit: "10" });
      if (searchScope === "workspace") params.set("workspaceId", workspaceId);
      const result = await apiRequest<{ skills: typeof matches }>(
        `/api/v1/skills/search?${params}`,
        {
          headers:
            searchScope === "workspace"
              ? { "x-skillplane-workspace-id": workspaceId }
              : {},
        },
      );
      matches = result.skills;
    } catch (cause) {
      searchError = cause instanceof Error ? cause.message : "Search failed";
    } finally {
      searching = false;
    }
  }
  function addMatch(match: (typeof matches)[number]) {
    let alias = match.slug;
    let suffix = 2;
    while (dependencies.some((d: Dependency) => d.alias === alias))
      alias = `${match.slug}-${String(suffix++)}`;
    dependencies = [
      ...dependencies,
      {
        alias,
        workspace: match.workspaceSlug,
        skill: match.slug,
        version: `^${match.semanticVersion}`,
        scope: "both",
        mode: "include",
        required: true,
      },
    ];
    onchange();
  }
</script>

<section aria-label="Composition and verification">
  <h3>Dependencies</h3>
  <p>
    Each dependency is locked to an exact published version when this candidate is
    created. Use the workspace and skill slugs from the skill catalog.
  </p>
  <div class="fields">
    <Input label="Search published skills" bind:value={query} />
    <Select
      label="Search in"
      options={[
        { value: "workspace", label: "This workspace" },
        { value: "public", label: "Public catalog" },
      ]}
      bind:value={searchScope}
    />
    <Button type="button" loading={searching} onclick={search}
      >Search dependencies</Button
    >
  </div>
  {#if searchError}<p role="alert">{searchError}</p>{/if}
  {#each matches as match (match.id)}<Button
      type="button"
      disabled={dependencies.length >= 32}
      onclick={() => addMatch(match)}
      >Add {match.workspaceSlug}/{match.slug} {match.semanticVersion}</Button
    >{/each}
  {#each dependencies as dependency, index (index)}
    <fieldset>
      <legend>Dependency {index + 1}</legend>
      <div class="fields">
        <Input
          label="Alias"
          required
          bind:value={dependency.alias}
          oninput={onchange}
        />
        <Input
          label="Workspace slug"
          required
          bind:value={dependency.workspace}
          oninput={onchange}
        />
        <Input
          label="Skill slug"
          required
          bind:value={dependency.skill}
          oninput={onchange}
        />
        <Input
          label="Version constraint"
          required
          bind:value={dependency.version}
          oninput={onchange}
        />
        <Select
          label="Scope"
          options={[
            { value: "execution", label: "Execution" },
            { value: "verification", label: "Verification" },
            { value: "both", label: "Both" },
          ]}
          bind:value={dependency.scope}
          {onchange}
        />
        <Select
          label="Mode"
          options={[
            { value: "include", label: "Include module" },
            { value: "invoke", label: "Invoke with handoff" },
          ]}
          bind:value={dependency.mode}
          {onchange}
        />
      </div>
      <Button
        type="button"
        onclick={() => {
          dependencies = dependencies.filter((_: Dependency, i: number) => i !== index);
          onchange();
        }}>Remove dependency</Button
      >
    </fieldset>
  {/each}
  <Button
    type="button"
    disabled={dependencies.length >= 32}
    onclick={() => {
      dependencies = [
        ...dependencies,
        {
          alias: "",
          workspace: "",
          skill: "",
          version: "^1.0.0",
          scope: "both",
          mode: "include",
          required: true,
        },
      ];
      onchange();
    }}>Add dependency</Button
  >
  <label
    ><input type="checkbox" bind:checked={verify} {onchange} /> Add verification module</label
  >
  {#if verify}
    <Textarea
      label="Verifier instructions"
      rows={8}
      required
      bind:value={verifier}
      oninput={onchange}
    />
    <Textarea
      label="Verification claims (JSON)"
      description="Each claim needs id, statement, severity, scope, requiredEvidence, prohibitedBypasses and pass/fail/unknown rules. Inherited blocking claims cannot be removed."
      rows={12}
      required
      bind:value={claims}
      oninput={onchange}
    />
  {/if}
</section>

<style>
  section {
    display: grid;
    gap: var(--sp-space-4);
  }
  fieldset {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-2);
    padding: var(--sp-space-4);
  }
  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--sp-space-3);
    margin-bottom: var(--sp-space-3);
  }
  p {
    color: var(--sp-color-text-muted);
  }
</style>
