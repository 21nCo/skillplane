<script lang="ts">
  import { apiRequest } from "$lib/api/client.js";
  import { listContexts } from "$lib/contexts/api.js";
  import type { SkillContext } from "$lib/contexts/types.js";
  import { Badge, Button, Input, Select } from "@skillplane/ui";
  import { getAmendmentPolicy, updateAmendmentPolicy } from "./api.js";
  import type {
    AmendmentPolicy,
    SemanticBump,
    TrustedAutoPublishRule,
  } from "./types.js";
  import { PlusIcon, ShieldCheckIcon, TrashIcon, WarningIcon } from "phosphor-svelte";

  interface ServicePrincipal {
    readonly id: string;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly revokedAt: string | null;
  }

  interface EditableRule {
    key: string;
    credentialId: string;
    maxBump: SemanticBump;
    dailyLimit: string;
    allowedContextIds: string[];
  }

  let {
    workspaceId,
    skillId,
    canManage,
  }: {
    workspaceId: string;
    skillId: string;
    canManage: boolean;
  } = $props();

  let mode = $state<AmendmentPolicy["mode"]>("review_required");
  let rules = $state<EditableRule[]>([]);
  let credentials = $state<ServicePrincipal[]>([]);
  let contexts = $state<SkillContext[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);
  let loadedKey = $state("");

  function editable(rule: TrustedAutoPublishRule): EditableRule {
    return {
      key: crypto.randomUUID(),
      credentialId: rule.credentialId,
      maxBump: rule.maxBump,
      dailyLimit: rule.dailyLimit === null ? "" : String(rule.dailyLimit),
      allowedContextIds: [...rule.allowedContextIds],
    };
  }

  function addRule() {
    rules = [
      ...rules,
      {
        key: crypto.randomUUID(),
        credentialId: credentials[0]?.id ?? "",
        maxBump: "patch",
        dailyLimit: "10",
        allowedContextIds: [],
      },
    ];
  }

  function setRule(index: number, patch: Partial<EditableRule>) {
    rules = rules.map((rule, candidateIndex) =>
      candidateIndex === index ? { ...rule, ...patch } : rule,
    );
  }

  function toggleContext(index: number, contextId: string, checked: boolean) {
    rules = rules.map((rule, candidateIndex) =>
      candidateIndex === index
        ? {
            ...rule,
            allowedContextIds: checked
              ? [...rule.allowedContextIds, contextId]
              : rule.allowedContextIds.filter((id) => id !== contextId),
          }
        : rule,
    );
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const [policy, principalData, availableContexts] = await Promise.all([
        getAmendmentPolicy({ workspaceId, skillId }),
        apiRequest<{ servicePrincipals: ServicePrincipal[] }>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/service-principals`,
          { headers: { "x-skillplane-workspace-id": workspaceId } },
        ),
        listContexts({ workspaceId, skillId }),
      ]);
      credentials = principalData.servicePrincipals.filter(
        (principal) =>
          !principal.revokedAt && principal.scopes.includes("skills:amend"),
      );
      contexts = [...availableContexts];
      mode = policy.mode;
      rules = policy.mode === "trusted_auto_publish" ? policy.rules.map(editable) : [];
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Amendment policy could not load.";
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (!canManage) return;
    saving = true;
    saved = false;
    error = null;
    try {
      const policy: AmendmentPolicy =
        mode === "review_required"
          ? { mode: "review_required" }
          : {
              mode: "trusted_auto_publish",
              rules: rules.map((rule) => ({
                credentialId: rule.credentialId,
                requiredScopes: ["skills:amend"],
                maxBump: rule.maxBump,
                allowedContextIds: rule.allowedContextIds,
                dailyLimit: rule.dailyLimit.trim() ? Number(rule.dailyLimit) : null,
              })),
            };
      const updated = await updateAmendmentPolicy({
        workspaceId,
        skillId,
        policy,
        idempotencyKey: crypto.randomUUID(),
      });
      mode = updated.mode;
      rules =
        updated.mode === "trusted_auto_publish" ? updated.rules.map(editable) : [];
      saved = true;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Amendment policy could not save.";
    } finally {
      saving = false;
    }
  }

  $effect(() => {
    const key = `${workspaceId}:${skillId}`;
    if (key !== loadedKey) {
      loadedKey = key;
      void load();
    }
  });
</script>

<div class="policy-editor" data-testid="policy-editor">
  {#if loading}
    <p class="muted">Loading the active amendment policy…</p>
  {:else}
    <div class="mode-grid">
      <button
        type="button"
        class:selected={mode === "review_required"}
        disabled={!canManage}
        onclick={() => {
          mode = "review_required";
          saved = false;
        }}
      >
        <ShieldCheckIcon weight="duotone" aria-hidden="true" />
        <span>
          <strong>Review required</strong>
          <small>Every amendment waits for an admin or owner.</small>
        </span>
        {#if mode === "review_required"}<Badge tone="info">Active</Badge>{/if}
      </button>
      <button
        type="button"
        class:selected={mode === "trusted_auto_publish"}
        disabled={!canManage}
        onclick={() => {
          mode = "trusted_auto_publish";
          if (rules.length === 0) addRule();
          saved = false;
        }}
      >
        <WarningIcon weight="duotone" aria-hidden="true" />
        <span>
          <strong>Trusted auto-publish</strong>
          <small>Only matching credentials, scopes, bumps, contexts, and limits.</small>
        </span>
        {#if mode === "trusted_auto_publish"}<Badge tone="warning">Active</Badge>{/if}
      </button>
    </div>

    {#if mode === "trusted_auto_publish"}
      <div class="matrix">
        <header>
          <div>
            <h3>Trust policy matrix</h3>
            <p>Every condition in one row must match. Otherwise review is required.</p>
          </div>
          {#if canManage}
            <Button size="sm" disabled={rules.length >= 50} onclick={addRule}>
              {#snippet leading()}
                <PlusIcon weight="bold" aria-hidden="true" />
              {/snippet}
              Add rule
            </Button>
          {/if}
        </header>

        {#if credentials.length === 0}
          <div class="warning">
            <WarningIcon weight="fill" aria-hidden="true" />
            Create an active service credential with the <code>skills:amend</code>
            scope before enabling auto-publish.
          </div>
        {/if}

        {#each rules as rule, index (rule.key)}
          <section class="rule">
            <div class="rule-heading">
              <span>Rule {index + 1}</span>
              {#if canManage}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove rule ${String(index + 1)}`}
                  onclick={() => (rules = rules.filter((_, i) => i !== index))}
                >
                  {#snippet leading()}
                    <TrashIcon weight="bold" aria-hidden="true" />
                  {/snippet}
                  Remove
                </Button>
              {/if}
            </div>
            <div class="rule-grid">
              <div>
                <Select
                  label="Trusted credential"
                  placeholder="Choose credential"
                  options={credentials.map((credential) => ({
                    value: credential.id,
                    label: credential.name,
                  }))}
                  value={rule.credentialId}
                  disabled={!canManage}
                  onchange={(event) =>
                    setRule(index, {
                      credentialId: event.currentTarget.value,
                    })}
                />
              </div>
              <div>
                <Select
                  label="Maximum bump"
                  options={[
                    { value: "patch", label: "Patch only" },
                    { value: "minor", label: "Patch or minor" },
                    { value: "major", label: "Up to major" },
                  ]}
                  value={rule.maxBump}
                  disabled={!canManage}
                  onchange={(event) =>
                    setRule(index, {
                      maxBump: event.currentTarget.value as SemanticBump,
                    })}
                />
              </div>
              <div>
                <Input
                  label="Daily publication limit"
                  description="Blank means no daily cap."
                  type="number"
                  min="1"
                  max="10000"
                  value={rule.dailyLimit}
                  disabled={!canManage}
                  oninput={(event) =>
                    setRule(index, { dailyLimit: event.currentTarget.value })}
                />
              </div>
            </div>
            <fieldset disabled={!canManage}>
              <legend>Allowed source contexts</legend>
              <p>No selection allows amendments with or without any context.</p>
              <div class="context-options">
                {#each contexts as context (context.id)}
                  <label>
                    <input
                      type="checkbox"
                      checked={rule.allowedContextIds.includes(context.id)}
                      onchange={(event) =>
                        toggleContext(index, context.id, event.currentTarget.checked)}
                    />
                    <span>{context.name}</span>
                    <code>{context.slug}</code>
                  </label>
                {/each}
                {#if contexts.length === 0}
                  <span class="muted">This skill has no active contexts.</span>
                {/if}
              </div>
            </fieldset>
          </section>
        {/each}
      </div>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if saved}<p class="saved" role="status">Amendment policy saved.</p>{/if}

    <div class="footer">
      {#if !canManage}
        <span class="muted">Only admins and owners can change publication policy.</span>
      {:else}
        <Button
          variant="primary"
          loading={saving}
          disabled={saving ||
            (mode === "trusted_auto_publish" &&
              (rules.length === 0 ||
                rules.some(
                  (rule) =>
                    !rule.credentialId ||
                    (rule.dailyLimit !== "" &&
                      (!Number.isInteger(Number(rule.dailyLimit)) ||
                        Number(rule.dailyLimit) < 1)),
                )))}
          onclick={() => void save()}
        >
          Save amendment policy
        </Button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .policy-editor {
    display: grid;
    gap: var(--sp-space-4);
  }

  .mode-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-3);
  }

  .mode-grid > button {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: var(--sp-space-3);
    align-items: start;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface-raised);
    color: var(--sp-color-text);
    text-align: left;
  }

  .mode-grid > button:not(:disabled) {
    cursor: pointer;
  }

  .mode-grid > button.selected {
    border-color: var(--sp-color-accent);
    box-shadow: 0 0 0 1px var(--sp-color-accent);
  }

  .mode-grid :global(svg) {
    width: 1.4rem;
    height: 1.4rem;
    color: var(--sp-color-accent-text);
  }

  .mode-grid span,
  .mode-grid small {
    display: block;
  }

  .mode-grid small {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    line-height: var(--sp-line-normal);
  }

  .matrix,
  .rule {
    display: grid;
    gap: var(--sp-space-3);
  }

  .matrix > header,
  .rule-heading,
  .footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
  }

  h3,
  p {
    margin: 0;
  }

  .matrix header p,
  fieldset p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .rule {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface-raised);
  }

  .rule-heading > span,
  legend {
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .rule-grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr 1fr;
    gap: var(--sp-space-3);
  }

  fieldset {
    margin: 0;
    border: 0;
    padding: 0;
  }

  .context-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    margin-top: var(--sp-space-2);
  }

  .context-options label {
    display: flex;
    gap: var(--sp-space-2);
    align-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-2);
    background: var(--sp-color-surface);
    font-size: var(--sp-font-size-2);
  }

  code {
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .warning {
    display: flex;
    gap: var(--sp-space-2);
    border: 1px solid var(--sp-color-warning);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    color: var(--sp-color-text-muted);
    background: var(--sp-color-warning-soft);
    font-size: var(--sp-font-size-2);
  }

  .muted {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .error,
  .saved {
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-2) var(--sp-space-3);
    font-size: var(--sp-font-size-2);
  }

  .error {
    color: var(--sp-color-danger);
    background: var(--sp-color-danger-soft);
  }

  .saved {
    color: var(--sp-color-success);
    background: var(--sp-color-success-soft);
  }

  @media (max-width: 54rem) {
    .rule-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 42rem) {
    .mode-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
