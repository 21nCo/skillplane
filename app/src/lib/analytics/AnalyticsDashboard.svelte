<script lang="ts">
  import { Badge, Button, Select, Skeleton } from "@skillplane/ui";
  import {
    ArrowClockwiseIcon,
    ChartLineUpIcon,
    CheckCircleIcon,
    GaugeIcon,
    RobotIcon,
    ShieldCheckIcon,
    UsersThreeIcon,
    WarningCircleIcon,
  } from "phosphor-svelte";
  import { getAnalytics } from "./api.js";
  import type { AnalyticsDimension, AnalyticsSnapshot } from "./types.js";

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

  let days = $state("30");
  let loading = $state(true);
  let error = $state<string | null>(null);
  let analytics = $state<AnalyticsSnapshot | null>(null);
  let request = 0;
  const metricSkeletons = [0, 1, 2, 3, 4, 5] as const;

  const dateRange = $derived.by(() => {
    const to = new Date();
    const from = new Date(to.getTime() - (Number(days) - 1) * 86_400_000);
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
    };
  });
  const maximum = $derived(
    Math.max(1, ...(analytics?.points.map((point) => point.retrievalCount) ?? [1])),
  );

  async function load() {
    const active = ++request;
    loading = true;
    error = null;
    try {
      const result = await getAnalytics({
        workspaceId,
        ...dateRange,
        ...(skillId ? { skillId } : {}),
      });
      if (active === request) analytics = result;
    } catch (cause) {
      if (active === request) {
        error =
          cause instanceof Error ? cause.message : "Analytics could not be loaded.";
      }
    } finally {
      if (active === request) loading = false;
    }
  }

  function number(value: number): string {
    return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
  }

  function duration(value: number | null): string {
    return value === null ? "—" : `${value.toFixed(value < 10 ? 1 : 0)} ms`;
  }

  function rate(value: number | null): string {
    return value === null
      ? "—"
      : new Intl.NumberFormat(undefined, {
          style: "percent",
          maximumFractionDigits: 1,
        }).format(value);
  }

  function dimensions(type: AnalyticsDimension["type"]) {
    return analytics?.dimensions.filter((item) => item.type === type).slice(0, 5) ?? [];
  }

  $effect(() => {
    void load();
  });
</script>

<svelte:head><title>{title} · Skillplane</title></svelte:head>

<section class="analytics-page" class:embedded aria-labelledby="analytics-title">
  <header class="page-heading">
    <div>
      <p class="eyebrow">Observability</p>
      <h1 id="analytics-title">{title}</h1>
      <p>{description}</p>
    </div>
    <div class="actions">
      <div class="range">
        <Select
          label="Time range"
          options={[
            { value: "7", label: "Last 7 days" },
            { value: "30", label: "Last 30 days" },
            { value: "90", label: "Last 90 days" },
          ]}
          bind:value={days}
        />
      </div>
      <Button variant="secondary" onclick={() => void load()} {loading}>
        {#snippet leading()}<ArrowClockwiseIcon weight="bold" />{/snippet}
        Refresh
      </Button>
    </div>
  </header>

  {#if loading && !analytics}
    <div class="metrics" aria-label="Loading analytics" aria-busy="true">
      {#each metricSkeletons as skeleton (skeleton)}
        <section class="metric">
          <Skeleton width="7rem" /><Skeleton height="2rem" />
        </section>
      {/each}
    </div>
    <section class="panel loading-panel">
      <Skeleton width="12rem" /><Skeleton height="13rem" />
    </section>
  {:else if error}
    <section class="state error-state" role="alert">
      <WarningCircleIcon weight="duotone" aria-hidden="true" />
      <div>
        <h2>Analytics could not be loaded</h2>
        <p>{error}</p>
        <Button onclick={() => void load()}>Retry</Button>
      </div>
    </section>
  {:else if analytics?.points.length === 0}
    <section class="state empty-state">
      <ChartLineUpIcon weight="duotone" aria-hidden="true" />
      <div>
        <h2>No usage in this range</h2>
        <p>
          Retrievals, amendments, approvals, and failures will appear after the daily
          UTC rollup.
        </p>
      </div>
    </section>
  {:else if analytics}
    <div class="metrics" aria-label="Analytics totals">
      <section class="metric">
        <span
          ><ChartLineUpIcon weight="duotone" aria-hidden="true" />Successful retrievals</span
        >
        <strong>{number(analytics.totals.retrievalCount)}</strong>
        <small>{number(analytics.totals.eventCount)} audited events</small>
      </section>
      <section class="metric">
        <span
          ><UsersThreeIcon weight="duotone" aria-hidden="true" />Authenticated
          principals</span
        >
        <strong>{number(analytics.totals.uniquePrincipalCount)}</strong>
        <small>Peak unique daily principals</small>
      </section>
      <section class="metric">
        <span
          ><RobotIcon weight="duotone" aria-hidden="true" />Caller-declared agents</span
        >
        <strong>{number(analytics.totals.uniqueAgentCount)}</strong>
        <small>{number(analytics.totals.uniqueModelCount)} declared models</small>
      </section>
      <section class="metric">
        <span
          ><GaugeIcon weight="duotone" aria-hidden="true" />Retrieval latency p95</span
        >
        <strong>{duration(analytics.totals.latencyP95Ms)}</strong>
        <small>p50 {duration(analytics.totals.latencyP50Ms)}</small>
      </section>
      <section class="metric">
        <span
          ><WarningCircleIcon weight="duotone" aria-hidden="true" />Failure rate</span
        >
        <strong>{rate(analytics.totals.failureRate)}</strong>
        <small>{number(analytics.totals.failureCount)} denied or failed</small>
      </section>
      <section class="metric">
        <span
          ><CheckCircleIcon weight="duotone" aria-hidden="true" />Current-version
          adoption</span
        >
        <strong>{rate(analytics.totals.adoptionRate)}</strong>
        <small
          >{number(analytics.totals.currentVersionRetrievalCount)} current-version reads</small
        >
      </section>
    </div>

    <section class="panel chart-panel" aria-labelledby="activity-title">
      <header>
        <div>
          <p class="eyebrow">UTC daily rollup</p>
          <h2 id="activity-title">Retrieval activity</h2>
        </div>
        <Badge tone="neutral">
          {analytics.generatedAt
            ? `Updated ${new Date(analytics.generatedAt).toLocaleString()}`
            : "Awaiting rollup"}
        </Badge>
      </header>
      <div
        class="chart"
        role="img"
        aria-label={`Successful retrievals per day from ${analytics.from} through ${analytics.to}`}
      >
        {#each analytics.points as point (point.day)}
          <div
            class="bar-column"
            title={`${point.day}: ${String(point.retrievalCount)} retrievals`}
          >
            <div
              class="bar"
              style={`height: ${String(Math.max(point.retrievalCount === 0 ? 0 : 4, (point.retrievalCount / maximum) * 100))}%`}
            ></div>
            <span
              >{new Date(`${point.day}T00:00:00Z`).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}</span
            >
          </div>
        {/each}
      </div>
    </section>

    <div class="dimension-grid">
      {#each [{ type: "agent" as const, title: "Caller-declared agents", icon: RobotIcon }, { type: "model" as const, title: "Caller-declared models", icon: ShieldCheckIcon }, { type: "context" as const, title: "Top contexts", icon: ChartLineUpIcon }, { type: "tool" as const, title: "MCP tools", icon: GaugeIcon }] as group (group.type)}
        <section class="panel dimension">
          <header>
            <h2><group.icon weight="duotone" aria-hidden="true" />{group.title}</h2>
            {#if group.type === "agent" || group.type === "model"}
              <Badge tone="warning">Declared</Badge>
            {/if}
          </header>
          <ol>
            {#each dimensions(group.type) as item (item.value)}
              <li>
                <span title={item.value}>{item.value}</span>
                <strong>{number(item.eventCount)}</strong>
              </li>
            {:else}
              <li class="muted">No dimension data</li>
            {/each}
          </ol>
        </section>
      {/each}
    </div>
  {/if}
</section>

<style>
  .analytics-page {
    width: min(100%, 84rem);
    margin: 0 auto;
    padding: var(--sp-space-6) var(--sp-space-6) var(--sp-space-16);
  }
  .analytics-page.embedded {
    width: 100%;
    padding: 0;
  }
  .page-heading,
  .actions,
  .panel > header,
  .metric span,
  .dimension h2 {
    display: flex;
    align-items: center;
  }
  .page-heading {
    justify-content: space-between;
    gap: var(--sp-space-4);
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
  .page-heading > div:first-child > p:last-child,
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
  .actions {
    gap: var(--sp-space-2);
    align-items: end;
  }
  .range {
    width: 10rem;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-space-3);
  }
  .metric,
  .panel,
  .state {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }
  .metric {
    min-width: 0;
    padding: var(--sp-space-4);
  }
  .metric span {
    gap: var(--sp-space-2);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-medium);
  }
  .metric span :global(svg),
  .dimension h2 :global(svg) {
    width: var(--sp-icon-md);
    height: var(--sp-icon-md);
    color: var(--sp-color-accent-text);
  }
  .metric strong {
    display: block;
    margin-top: var(--sp-space-3);
    font-size: var(--sp-font-size-7);
    letter-spacing: -0.04em;
  }
  .metric small {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }
  .panel {
    padding: var(--sp-space-4);
  }
  .chart-panel,
  .loading-panel {
    margin-top: var(--sp-space-4);
  }
  .panel > header {
    justify-content: space-between;
    gap: var(--sp-space-3);
    margin-bottom: var(--sp-space-4);
  }
  .panel h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-5);
  }
  .chart {
    display: flex;
    height: 15rem;
    gap: clamp(2px, 0.5vw, 0.5rem);
    align-items: end;
    border-bottom: 1px solid var(--sp-color-border);
    padding-top: var(--sp-space-4);
  }
  .bar-column {
    display: grid;
    min-width: 0;
    height: 100%;
    flex: 1;
    grid-template-rows: minmax(0, 1fr) 1.75rem;
    align-items: end;
  }
  .bar {
    width: 100%;
    min-height: 1px;
    border-radius: var(--sp-radius-sm) var(--sp-radius-sm) 0 0;
    background: var(--sp-color-accent);
  }
  .bar-column span {
    overflow: hidden;
    padding-top: var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-size: 0.625rem;
    text-align: center;
    text-overflow: clip;
    white-space: nowrap;
  }
  .dimension-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-4);
    margin-top: var(--sp-space-4);
  }
  .dimension h2 {
    gap: var(--sp-space-2);
    margin: 0;
    font-size: var(--sp-font-size-4);
  }
  ol {
    display: grid;
    gap: var(--sp-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
    border-top: 1px solid var(--sp-color-border);
    padding-top: var(--sp-space-2);
    font-size: var(--sp-font-size-2);
  }
  li span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li strong {
    font-family: var(--sp-font-mono);
  }
  .muted {
    color: var(--sp-color-text-subtle);
  }
  .state {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-4);
    align-items: start;
    padding: var(--sp-space-6);
  }
  .state > :global(svg) {
    width: 2rem;
    height: 2rem;
    color: var(--sp-color-accent-text);
  }
  .state h2 {
    font-size: var(--sp-font-size-5);
  }
  .state :global(button) {
    margin-top: var(--sp-space-3);
  }
  .error-state > :global(svg) {
    color: var(--sp-color-danger);
  }
  @media (max-width: 62rem) {
    .metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 47.999rem) {
    .analytics-page {
      padding: var(--sp-space-4) var(--sp-space-3) var(--sp-space-12);
    }
    .page-heading {
      align-items: stretch;
      flex-direction: column;
    }
    .actions {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .range {
      width: auto;
    }
    .metrics,
    .dimension-grid {
      grid-template-columns: 1fr;
    }
    .chart {
      overflow: hidden;
    }
    .bar-column:nth-child(2n) span {
      color: transparent;
    }
  }
</style>
