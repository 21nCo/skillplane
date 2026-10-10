<script module lang="ts">
  import type { Snippet } from "svelte";

  export interface DataTableColumn<Item extends Record<string, unknown>> {
    readonly id: string;
    readonly label: string;
    readonly align?: "start" | "end";
    readonly sortable?: boolean;
    readonly value: (row: Item) => string | number | null | undefined;
  }

  export interface DataTableProps<Item extends Record<string, unknown>> {
    label: string;
    rows: readonly Item[];
    columns: readonly DataTableColumn<Item>[];
    rowKey: (row: Item) => string;
    caption?: string;
    loading?: boolean;
    sort?: { readonly column: string; readonly direction: "asc" | "desc" };
    onSort?: (column: string) => void;
    rowActions?: Snippet<[Item]>;
    emptyTitle?: string;
    emptyDescription?: string;
  }
</script>

<script lang="ts" generics="Row extends Record<string, unknown>">
  import { CaretUpDownIcon } from "phosphor-svelte";
  import EmptyState from "./EmptyState.svelte";

  let {
    label,
    rows,
    columns,
    rowKey,
    caption,
    loading = false,
    sort,
    onSort,
    rowActions,
    emptyTitle = "No results",
    emptyDescription = "Try changing the filters or create the first item.",
  }: DataTableProps<Row> = $props();
</script>

{#if loading}
  <div class="loading" aria-label={`Loading ${label}`} aria-busy="true">
    {#each [0, 1, 2, 3] as index (index)}<span></span>{/each}
  </div>
{:else if rows.length === 0}
  <EmptyState title={emptyTitle} description={emptyDescription} compact />
{:else}
  <div class="scroll" role="region" aria-label={label}>
    <table>
      {#if caption}<caption>{caption}</caption>{/if}
      <thead>
        <tr>
          {#each columns as column (column.id)}
            <th
              scope="col"
              class:align-end={column.align === "end"}
              aria-sort={column.sortable
                ? sort?.column === column.id
                  ? sort.direction === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
                : undefined}
            >
              {#if column.sortable}
                <button
                  type="button"
                  onclick={() => onSort?.(column.id)}
                  aria-label={`Sort by ${column.label}`}
                >
                  {column.label}
                  <CaretUpDownIcon size={14} aria-hidden="true" />
                </button>
              {:else}
                {column.label}
              {/if}
            </th>
          {/each}
          {#if rowActions}<th scope="col"><span class="sr-only">Actions</span></th>{/if}
        </tr>
      </thead>
      <tbody>
        {#each rows as row (rowKey(row))}
          <tr>
            {#each columns as column (column.id)}
              <td class:align-end={column.align === "end"}
                >{column.value(row) ?? "—"}</td
              >
            {/each}
            {#if rowActions}<td class="actions">{@render rowActions(row)}</td>{/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .scroll {
    overflow: auto;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--sp-font-size-3);
  }

  caption {
    padding: var(--sp-space-3);
    color: var(--sp-color-text-muted);
    text-align: left;
  }

  th,
  td {
    height: var(--sp-row-height);
    padding: 0 var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
    text-align: left;
    white-space: nowrap;
  }

  th {
    position: sticky;
    z-index: 1;
    top: 0;
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  th button {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-1);
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-transform: inherit;
  }

  tbody tr:hover {
    background: var(--sp-color-surface-hover);
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  .align-end {
    text-align: right;
  }

  .actions {
    width: 1%;
    text-align: right;
  }

  .sr-only {
    position: absolute;
    overflow: hidden;
    width: 1px;
    height: 1px;
    clip: rect(0 0 0 0);
  }

  .loading {
    display: grid;
    gap: 1px;
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
  }

  .loading span {
    height: var(--sp-row-height);
    background: linear-gradient(
      90deg,
      var(--sp-color-surface-muted),
      var(--sp-color-skeleton),
      var(--sp-color-surface-muted)
    );
    background-size: 200% 100%;
    animation: shimmer 1.4s linear infinite;
  }

  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
</style>
