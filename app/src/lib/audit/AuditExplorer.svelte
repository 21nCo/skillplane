<script lang="ts">
  import { Badge, Button, Input, Select, Skeleton } from "@skillplane/ui";
  import {
    ArrowClockwiseIcon,
    DownloadSimpleIcon,
    FunnelIcon,
    LockKeyIcon,
    ShieldCheckIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { downloadAuditCsv, getAuditEvents } from "./api.js";
  import type { AuditEvent, AuditFilterValues, AuditOutcome } from "./types.js";

  let {
    workspaceId,
    skillId,
    title,
    description,
    embedded = false,
  }: {
    workspaceId: string;
    skillId?: string;
    title: string;
    description: string;
    embedded?: boolean;
  } = $props();

  const today = new Date();
  const initialFrom = new Date(today.getTime() - 29 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  let from = $state(initialFrom);
  let to = $state(today.toISOString().slice(0, 10));
  let outcome = $state("");
  let tool = $state("");
  let agent = $state("");
  let model = $state("");
  let contextId = $state("");
  let events = $state<AuditEvent[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let exporting = $state(false);
  let error = $state<string | null>(null);
  let exportError = $state<string | null>(null);
  const resultSkeletons = [0, 1, 2, 3, 4] as const;

  function currentFilters(): AuditFilterValues {
    return {
      from,
      to,
      ...(outcome ? { outcome: outcome as AuditOutcome } : {}),
      ...(tool.trim() ? { tool: tool.trim() } : {}),
      ...(agent.trim() ? { agent: agent.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
      ...(contextId.trim() ? { contextId: contextId.trim() } : {}),
    };
  }

  async function load(reset = true) {
    if (reset) loading = true;
    else loadingMore = true;
    error = null;
    try {
      const result = await getAuditEvents({
        workspaceId,
        ...(skillId ? { skillId } : {}),
        filters: currentFilters(),
        ...(!reset && nextCursor ? { cursor: nextCursor } : {}),
      });
      events = reset ? [...result.events] : [...events, ...result.events];
      nextCursor = result.nextCursor;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Audit history could not be loaded.";
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  function apply(event: SubmitEvent) {
    event.preventDefault();
    void load();
  }

  function resetFilters() {
    from = initialFrom;
    to = today.toISOString().slice(0, 10);
    outcome = "";
    tool = "";
    agent = "";
    model = "";
    contextId = "";
    void load();
  }

  async function exportCurrent() {
    exporting = true;
    exportError = null;
    try {
      await downloadAuditCsv({
        workspaceId,
        ...(skillId ? { skillId } : {}),
        filters: currentFilters(),
      });
    } catch (cause) {
      exportError =
        cause instanceof Error ? cause.message : "Audit export could not be created.";
    } finally {
      exporting = false;
    }
  }

  function callerValue(event: AuditEvent, key: string): string | null {
    const value = event.caller?.[key];
    return typeof value === "string" ? value : null;
  }

  function credentialValue(event: AuditEvent, key: string): string | null {
    const value = event.credential?.[key];
    return typeof value === "string" ? value : null;
  }

  function tone(value: AuditOutcome): "success" | "warning" | "danger" {
    return value === "success" ? "success" : value === "denied" ? "warning" : "danger";
  }

  $effect(() => {
    void load();
  });
</script>

<svelte:head><title>{title} · Skillplane</title></svelte:head>

<section class="audit-page" class:embedded aria-labelledby="audit-title">
  <header class="page-heading">
    <div>
      <p class="eyebrow">Security ledger</p>
      <h1 id="audit-title">{title}</h1>
      <p>{description}</p>
    </div>
    <Button onclick={() => void exportCurrent()} loading={exporting}>
      {#snippet leading()}<DownloadSimpleIcon weight="bold" />{/snippet}
      Export current filters
    </Button>
  </header>

  {#if exportError}
    <div class="inline-error" role="alert">
      <WarningCircleIcon weight="bold" aria-hidden="true" />
      {exportError}
    </div>
  {/if}

  <form class="filters" aria-label="Audit filters" onsubmit={apply}>
    <div class="filter-title">
      <FunnelIcon weight="duotone" aria-hidden="true" /><strong>Filters</strong>
    </div>
    <label>
      <span>From</span>
      <input type="date" required bind:value={from} max={to} />
    </label>
    <label>
      <span>To</span>
      <input type="date" required bind:value={to} min={from} />
    </label>
    <Select
      label="Outcome"
      options={[
        { value: "", label: "All outcomes" },
        { value: "success", label: "Success" },
        { value: "denied", label: "Denied" },
        { value: "error", label: "Error" },
      ]}
      bind:value={outcome}
    />
    <Input
      label="Tool"
      placeholder="skill_retrieve"
      maxlength={200}
      bind:value={tool}
    />
    <Input
      label="Caller-declared agent"
      placeholder="codex"
      maxlength={200}
      bind:value={agent}
    />
    <Input
      label="Caller-declared model"
      placeholder="gpt-5"
      maxlength={200}
      bind:value={model}
    />
    <Input
      label="Context ID"
      placeholder="context:…"
      maxlength={200}
      bind:value={contextId}
    />
    <div class="filter-actions">
      <Button type="submit" {loading}>Apply filters</Button>
      <Button variant="ghost" onclick={resetFilters}>Reset</Button>
    </div>
  </form>

  {#if loading && events.length === 0}
    <section
      class="results loading"
      aria-label="Loading audit history"
      aria-busy="true"
    >
      {#each resultSkeletons as skeleton (skeleton)}
        <div>
          <Skeleton width="8rem" /><Skeleton width="14rem" /><Skeleton width="10rem" />
        </div>
      {/each}
    </section>
  {:else if error && events.length === 0}
    <section class="state" role="alert">
      <WarningCircleIcon weight="duotone" aria-hidden="true" />
      <div>
        <h2>Audit history could not be loaded</h2>
        <p>{error}</p>
        <Button onclick={() => void load()}>Retry</Button>
      </div>
    </section>
  {:else if events.length === 0}
    <section class="state">
      <ShieldCheckIcon weight="duotone" aria-hidden="true" />
      <div>
        <h2>No events match these filters</h2>
        <p>
          Broaden the date range or remove a caller, context, tool, or outcome filter.
        </p>
        <Button variant="secondary" onclick={resetFilters}>Clear filters</Button>
      </div>
    </section>
  {:else}
    <section class="results" aria-labelledby="results-title">
      <header>
        <div>
          <p class="eyebrow">Redacted tenant history</p>
          <h2 id="results-title">{events.length} audit events</h2>
        </div>
        <Button variant="ghost" size="sm" onclick={() => void load()} {loading}>
          {#snippet leading()}<ArrowClockwiseIcon weight="bold" />{/snippet}
          Refresh
        </Button>
      </header>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Scrollable data region must be keyboard focusable.) -->
      <div
        class="table-scroll"
        role="region"
        tabindex="0"
        aria-label="Audit events table"
      >
        <table>
          <thead>
            <tr>
              <th>Time / outcome</th>
              <th>Tool / resource</th>
              <th>Authenticated principal</th>
              <th>Caller-declared identity</th>
              <th>Latency / request</th>
            </tr>
          </thead>
          <tbody>
            {#each events as event (event.id)}
              <tr>
                <td data-label="Time / outcome">
                  <time datetime={event.occurredAt}>
                    {new Intl.DateTimeFormat(undefined, {
                      dateStyle: "medium",
                      timeStyle: "medium",
                    }).format(new Date(event.occurredAt))}
                  </time>
                  <Badge tone={tone(event.outcome)}>{event.outcome}</Badge>
                  {#if event.retentionClass === "permanent"}
                    <Badge tone="neutral"
                      ><LockKeyIcon weight="bold" aria-hidden="true" /> permanent</Badge
                    >
                  {/if}
                </td>
                <td data-label="Tool / resource">
                  <strong>{event.tool}</strong>
                  <code
                    >{event.resourceType ?? "workspace"}:{event.resourceId ??
                      workspaceId}</code
                  >
                  {#if event.contextId}<small>context {event.contextId}</small>{/if}
                  {#if event.errorCode}<small class="danger">{event.errorCode}</small
                    >{/if}
                </td>
                <td data-label="Authenticated principal">
                  <span class="trust authenticated">Authenticated</span>
                  <strong>{event.principal.actorType.replace("_", " ")}</strong>
                  <code>{event.principal.actorId}</code>
                  {#if credentialValue(event, "kind")}
                    <small
                      >{credentialValue(event, "kind")} · {credentialValue(
                        event,
                        "id",
                      )}</small
                    >
                  {/if}
                </td>
                <td data-label="Caller-declared identity">
                  {#if event.caller}
                    <span class="trust declared">Caller-declared</span>
                    <strong>{callerValue(event, "agentName") ?? "Unnamed agent"}</strong
                    >
                    <small
                      >{callerValue(event, "modelProvider")} · {callerValue(
                        event,
                        "modelName",
                      )}
                      {callerValue(event, "modelVersion")}</small
                    >
                    <code
                      >{callerValue(event, "clientName")}
                      {callerValue(event, "clientVersion")}</code
                    >
                  {:else}
                    <span class="muted">No caller declaration</span>
                  {/if}
                </td>
                <td data-label="Latency / request">
                  <strong
                    >{event.latencyMs === null
                      ? "—"
                      : `${event.latencyMs.toFixed(1)} ms`}</strong
                  >
                  <code title={event.requestId}>{event.requestId}</code>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if error}
        <div class="inline-error" role="alert">{error}</div>
      {/if}
      {#if nextCursor}
        <div class="more">
          <Button
            variant="secondary"
            onclick={() => void load(false)}
            loading={loadingMore}
          >
            Load older events
          </Button>
        </div>
      {/if}
    </section>
  {/if}
</section>

<style>
  .audit-page {
    width: min(100%, 90rem);
    margin: 0 auto;
    padding: var(--sp-space-6) var(--sp-space-6) var(--sp-space-16);
  }
  .audit-page.embedded {
    width: 100%;
    padding: 0;
  }
  .page-heading,
  .results > header,
  .filter-title,
  .inline-error {
    display: flex;
    align-items: center;
  }
  .page-heading,
  .results > header {
    justify-content: space-between;
    gap: var(--sp-space-4);
  }
  .page-heading {
    margin-bottom: var(--sp-space-5);
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  h1 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-7);
    letter-spacing: -0.035em;
  }
  .page-heading p:last-child,
  .state p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
  }
  .eyebrow {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .filters,
  .results,
  .state {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }
  .filters {
    display: grid;
    grid-template-columns: auto repeat(3, minmax(8rem, 1fr));
    gap: var(--sp-space-3);
    align-items: end;
    padding: var(--sp-space-4);
  }
  .filter-title {
    grid-column: 1 / -1;
    gap: var(--sp-space-2);
    padding-bottom: var(--sp-space-2);
    border-bottom: 1px solid var(--sp-color-border);
  }
  .filter-title :global(svg) {
    color: var(--sp-color-accent-text);
  }
  .filters label > span {
    display: block;
    margin-bottom: var(--sp-space-2);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
  }
  input[type="date"] {
    width: 100%;
    height: var(--sp-control-height);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: 0 var(--sp-control-padding-x);
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
    color-scheme: dark light;
    font: inherit;
  }
  input[type="date"]:focus {
    border-color: var(--sp-color-focus);
    outline: 2px solid transparent;
    box-shadow: 0 0 0 1px var(--sp-color-focus);
  }
  .filter-actions {
    display: flex;
    gap: var(--sp-space-2);
  }
  .results,
  .state {
    margin-top: var(--sp-space-4);
  }
  .results > header {
    padding: var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
  }
  .results h2,
  .state h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-5);
  }
  .table-scroll {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--sp-font-size-2);
  }
  th,
  td {
    min-width: 10rem;
    padding: var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
    text-align: left;
    vertical-align: top;
  }
  th {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  td {
    max-width: 22rem;
  }
  td > * {
    display: block;
    margin-top: var(--sp-space-1);
  }
  td > :first-child {
    margin-top: 0;
  }
  td :global(.sp-badge),
  td :global([data-tone]) {
    display: inline-flex;
    margin-right: var(--sp-space-1);
  }
  code {
    overflow: hidden;
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  small,
  time,
  .muted {
    color: var(--sp-color-text-muted);
  }
  .danger {
    color: var(--sp-color-danger);
  }
  .trust {
    width: fit-content;
    border-radius: var(--sp-radius-sm);
    padding: 2px var(--sp-space-1);
    font-size: 0.625rem;
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .authenticated {
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
  }
  .declared {
    background: var(--sp-color-warning-soft);
    color: var(--sp-color-warning);
  }
  .more {
    display: flex;
    justify-content: center;
    padding: var(--sp-space-4);
  }
  .state {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-4);
    padding: var(--sp-space-6);
  }
  .state > :global(svg) {
    width: 2rem;
    height: 2rem;
    color: var(--sp-color-accent-text);
  }
  .state :global(button) {
    margin-top: var(--sp-space-3);
  }
  .inline-error {
    gap: var(--sp-space-2);
    margin: 0 0 var(--sp-space-3);
    border: 1px solid var(--sp-color-danger);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-danger-soft);
    color: var(--sp-color-danger);
    font-size: var(--sp-font-size-2);
  }
  .loading {
    padding: 0;
  }
  .loading > div {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--sp-space-4);
    padding: var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
  }
  @media (max-width: 68rem) {
    .filters {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 47.999rem) {
    .audit-page {
      padding: var(--sp-space-4) var(--sp-space-3) var(--sp-space-12);
    }
    .page-heading {
      align-items: stretch;
      flex-direction: column;
    }
    .filters {
      grid-template-columns: 1fr;
    }
    .filter-title {
      grid-column: auto;
    }
    table,
    thead,
    tbody,
    tr,
    td {
      display: block;
    }
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
    tr {
      padding: var(--sp-space-2) var(--sp-space-3);
      border-bottom: 1px solid var(--sp-color-border);
    }
    td {
      display: grid;
      max-width: none;
      grid-template-columns: 8rem minmax(0, 1fr);
      gap: var(--sp-space-1) var(--sp-space-3);
      border: 0;
      padding: var(--sp-space-2) 0;
    }
    td::before {
      grid-row: 1 / span 6;
      color: var(--sp-color-text-subtle);
      content: attr(data-label);
      font-size: var(--sp-font-size-1);
      font-weight: var(--sp-weight-bold);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    td > * {
      grid-column: 2;
    }
  }
</style>
