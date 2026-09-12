<script lang="ts">
  import { Button } from "@skillplane/ui";
  import { apiRequest, jsonBody } from "$lib/api/client.js";
  import type { SkillVersion } from "./types.js";
  interface Plan {
    closureDigest: string;
    root: { versionId: string };
    dag: {
      nodes: {
        versionId: string;
        workspace: string;
        skill: string;
        semanticVersion: string;
      }[];
      edges: {
        parent: string;
        child: string;
        alias: string;
        scope: string;
        mode: string;
      }[];
    };
    verificationPlan: {
      claims: {
        namespacedId: string;
        statement: string;
        severity: string;
        scope: string;
        requiredEvidence: string[];
      }[];
    };
    warnings: string[];
  }
  let {
    workspaceId,
    skillId,
    version,
    publicView = false,
    canEdit = false,
    onCreated = () => undefined,
  } = $props<{
    workspaceId: string;
    skillId: string;
    version: Pick<SkillVersion, "id" | "baseVersionId" | "status">;
    publicView?: boolean;
    canEdit?: boolean;
    onCreated?: (version: SkillVersion) => void;
  }>();
  let plan = $state<Plan | null>(null),
    error = $state<string | null>(null),
    busy = $state(false),
    runId = $state("");
  let results = $state<{
    status: string;
    commit_sha: string;
    environment: string;
    results: { claimId: string; status: string; explanation: string }[];
  } | null>(null);
  let previous = $state<Plan | null>(null);
  let runs = $state<
    { id: string; version_id: string; status: string; commit_sha: string }[]
  >([]);
  let upgrades = $state<{
    available: boolean;
    added: { skill: string; semanticVersion: string }[];
    removed: { skill: string; semanticVersion: string }[];
  } | null>(null);

  const headers = () =>
    new Headers(publicView ? {} : { "x-skillplane-workspace-id": workspaceId });
  const prefix = () =>
    `/api/v1/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(version.id)}`;
  $effect(() => {
    const id = version.id,
      base = version.baseVersionId;
    let active = true;
    plan = null;
    previous = null;
    error = null;
    results = null;
    runs = [];
    upgrades = null;
    void apiRequest<{ plan: Plan }>(`${prefix()}/resolve`, { headers: headers() })
      .then((r) => {
        if (active && id === version.id) plan = r.plan;
      })
      .catch((e: unknown) => {
        if (active) error = e instanceof Error ? e.message : "Resolution failed";
      });
    if (base)
      void apiRequest<{ plan: Plan }>(
        `/api/v1/skills/${encodeURIComponent(skillId)}/versions/${encodeURIComponent(base)}/resolve`,
        { headers: headers() },
      )
        .then((r) => {
          if (active) previous = r.plan;
        })
        .catch((cause: unknown) => {
          if (active)
            error =
              cause instanceof Error
                ? cause.message
                : "Could not load composition details";
        });
    if (!publicView) {
      void apiRequest<{ runs: typeof runs }>(
        `/api/v1/skills/${encodeURIComponent(skillId)}/verification-runs`,
        { headers: headers() },
      )
        .then((r) => {
          if (active) runs = r.runs.filter((run) => run.version_id === id);
        })
        .catch((cause: unknown) => {
          if (active)
            error =
              cause instanceof Error
                ? cause.message
                : "Could not load composition details";
        });
      if (version.status === "published")
        void apiRequest<NonNullable<typeof upgrades>>(
          `${prefix()}/dependency-upgrade`,
          { headers: headers() },
        )
          .then((r) => {
            if (active) upgrades = r;
          })
          .catch((cause: unknown) => {
            if (active)
              error =
                cause instanceof Error
                  ? cause.message
                  : "Could not load composition details";
          });
    }
    return () => {
      active = false;
    };
  });
  async function upgrade() {
    busy = true;
    error = null;
    try {
      const h = headers();
      h.set("idempotency-key", crypto.randomUUID());
      const r = await apiRequest<{ version: SkillVersion }>(
        `${prefix()}/dependency-upgrade`,
        { method: "POST", headers: h, ...jsonBody({}) },
      );
      onCreated(r.version);
    } catch (e) {
      error = e instanceof Error ? e.message : "Upgrade failed";
    } finally {
      busy = false;
    }
  }
  async function getRun() {
    error = null;
    try {
      const r = await apiRequest<{ run: NonNullable<typeof results> }>(
        `/api/v1/skills/${encodeURIComponent(skillId)}/verification-runs/${encodeURIComponent(runId)}`,
        { headers: headers() },
      );
      results = r.run;
    } catch (e) {
      error = e instanceof Error ? e.message : "Run not found";
    }
  }
</script>

<section aria-label="Dependency graph and verification">
  <h2>Composition and verification</h2>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if plan}
    <p>Closure digest <code>{plan.closureDigest}</code></p>
    {#each plan.warnings as warning (warning)}<p>{warning}</p>{/each}
    {#if plan.dag.edges.length}
      <table>
        <caption>Locked dependency graph</caption><thead
          ><tr
            ><th>Parent</th><th>Alias</th><th>Dependency</th><th>Scope</th><th>Mode</th
            ></tr
          ></thead
        ><tbody>
          {#each plan.dag.edges as edge (`${edge.parent}/${edge.alias}`)}
            {@const child = plan.dag.nodes.find((n) => n.versionId === edge.child)}
            <tr
              ><td
                >{edge.parent === "$root"
                  ? "This skill"
                  : plan.dag.nodes.find((n) => n.versionId === edge.parent)?.skill}</td
              ><td>{edge.alias}</td><td
                >{child?.workspace}/{child?.skill} {child?.semanticVersion}</td
              ><td>{edge.scope}</td><td>{edge.mode}</td></tr
            >
          {/each}</tbody
        >
      </table>
      {#if version.status === "published" && canEdit && !publicView}<Button
          type="button"
          loading={busy}
          onclick={upgrade}>Create dependency upgrade candidate</Button
        >{/if}
    {:else}<p>This version has no dependencies.</p>{/if}
    {#if previous && previous.closureDigest !== plan.closureDigest}
      <h3>Dependency changes from base</h3>
      {#each plan.dag.nodes.filter((n) => !previous?.dag.nodes.some((p) => p.versionId === n.versionId)) as node (node.versionId)}<p
        >
          Added {node.workspace}/{node.skill}
          {node.semanticVersion}
        </p>{/each}
      {#each previous.dag.nodes.filter((n) => !plan?.dag.nodes.some((p) => p.versionId === n.versionId)) as node (node.versionId)}<p
        >
          Removed {node.workspace}/{node.skill}
          {node.semanticVersion}
        </p>{/each}
    {/if}
    {#if upgrades?.available}<h3>Available dependency upgrades</h3>
      {#each upgrades.added as node (`${node.skill}/${node.semanticVersion}`)}<p>
          {node.skill} → {node.semanticVersion}
        </p>{/each}{/if}
    <h3>Verification obligations</h3>
    {#each plan.verificationPlan.claims as claim (claim.namespacedId)}
      <details>
        <summary>{claim.severity}: {claim.statement}</summary>
        <p>{claim.scope}</p>
        <p>Required evidence: {claim.requiredEvidence.join(", ")}</p>
        <code>{claim.namespacedId}</code>
      </details>
    {:else}<p>No verification claims are declared.</p>{/each}
    {#if !publicView}
      <h3>Recent verification runs</h3>
      {#each runs as run (run.id)}<Button
          type="button"
          onclick={() => {
            runId = run.id;
            void getRun();
          }}>{run.status} · {run.commit_sha.slice(0, 12)}</Button
        >{:else}<p>No verification runs for this version.</p>{/each}
      <form
        onsubmit={(e) => {
          e.preventDefault();
          void getRun();
        }}
      >
        <label>Verification run ID <input required bind:value={runId} /></label><Button
          type="submit">View verification result</Button
        >
      </form>
      {#if results}<p>
          Attestation: {results.status} · {results.commit_sha} · {results.environment}
        </p>
        {#each results.results as result (result.claimId)}<p>
            {result.claimId}: {result.status} — {result.explanation}
          </p>{/each}{/if}
    {/if}
  {:else if !error}<p role="status">Resolving the immutable closure…</p>{/if}
</section>

<style>
  section {
    display: grid;
    gap: var(--sp-space-3);
    margin-block: var(--sp-space-5);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  th,
  td {
    padding: var(--sp-space-2);
    text-align: left;
    border-bottom: 1px solid var(--sp-color-border);
  }
  code {
    overflow-wrap: anywhere;
    font-size: var(--sp-font-size-2);
  }
  form {
    display: flex;
    gap: var(--sp-space-2);
    flex-wrap: wrap;
  }
</style>
