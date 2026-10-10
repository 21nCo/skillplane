<script lang="ts">
  import { Button, Input, Select, Textarea } from "@skillplane/ui";
  import { WarningCircleIcon } from "phosphor-svelte";
  import { updateContext } from "./api.js";
  import { parseJsonObject } from "./metadata.js";
  import type { ContextType, SkillContext } from "./types.js";

  let {
    workspaceId,
    context,
    onSaved,
    onCancel,
  }: {
    workspaceId: string;
    context: SkillContext;
    onSaved: (context: SkillContext) => void;
    onCancel: () => void;
  } = $props();

  function initialContext() {
    return {
      name: context.name,
      type: context.type,
      externalReference: context.externalReference ?? "",
      description: context.description,
      metadataSource: JSON.stringify(context.metadata, null, 2),
    };
  }

  const initial = initialContext();
  let name = $state(initial.name);
  let type = $state<ContextType>(initial.type);
  let externalReference = $state(initial.externalReference);
  let description = $state(initial.description);
  let metadataSource = $state(initial.metadataSource);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let requestFingerprint = "";
  let idempotencyKey = crypto.randomUUID();

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = null;
    try {
      const patch = {
        name,
        type,
        externalReference: externalReference.trim() || null,
        description,
        metadata: parseJsonObject(metadataSource, "Context metadata"),
      };
      const fingerprint = JSON.stringify(patch);
      if (requestFingerprint !== fingerprint) {
        requestFingerprint = fingerprint;
        idempotencyKey = crypto.randomUUID();
      }
      onSaved(
        await updateContext({
          workspaceId,
          contextId: context.id,
          patch,
          idempotencyKey,
        }),
      );
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Context details could not be saved.";
    } finally {
      saving = false;
    }
  }
</script>

<form onsubmit={submit}>
  <div class="two-column">
    <Input label="Name" maxlength={160} required bind:value={name} data-autofocus />
    <Select
      label="Context type"
      options={[
        { value: "repository", label: "Repository" },
        { value: "project", label: "Project" },
        { value: "customer", label: "Customer" },
        { value: "environment", label: "Environment" },
        { value: "custom", label: "Custom" },
      ]}
      bind:value={type}
    />
  </div>
  <Input label="External reference" maxlength={2000} bind:value={externalReference} />
  <Textarea label="Description" rows={3} maxlength={2000} bind:value={description} />
  <Textarea
    label="Context metadata (JSON)"
    rows={7}
    required
    bind:value={metadataSource}
  />
  {#if error}
    <p class="error" role="alert">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      {error}
    </p>
  {/if}
  <footer>
    <Button type="button" variant="secondary" onclick={onCancel}>Cancel</Button>
    <Button type="submit" loading={saving}>Save context details</Button>
  </footer>
</form>

<style>
  form {
    display: grid;
    gap: var(--sp-space-4);
  }

  .two-column {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-4);
    align-items: start;
  }

  footer,
  .error {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--sp-space-2);
  }

  .error {
    justify-content: flex-start;
    margin: 0;
    color: var(--sp-color-danger);
    font-size: var(--sp-font-size-3);
  }

  @media (max-width: 38rem) {
    .two-column {
      grid-template-columns: 1fr;
    }
  }
</style>
