<script lang="ts">
  import {
    CheckIcon as Check,
    LockKeyIcon as LockKey,
    ShieldCheckIcon as ShieldCheck,
  } from "phosphor-svelte";
  import { SECURITY_PRACTICES } from "$lib/content.js";
</script>

<section id="security" class="security" aria-labelledby="security-title">
  <div class="security-inner">
    <div class="security-copy">
      <span class="security-icon"
        ><ShieldCheck size={24} weight="duotone" aria-hidden="true" /></span
      >
      <p class="eyebrow">Security and provenance</p>
      <h2 id="security-title">Trust the process, then verify every step.</h2>
      <p class="lede">
        Skillplane separates published content from candidate learning, applies
        workspace authorization before data ranking, and records who or what caused each
        important action.
      </p>
      <ul>
        {#each SECURITY_PRACTICES as practice (practice)}
          <li><Check size={15} weight="bold" aria-hidden="true" /> {practice}</li>
        {/each}
      </ul>
    </div>

    <div class="audit-window" aria-label="Example audit event">
      <div class="audit-header">
        <span><LockKey size={15} weight="fill" aria-hidden="true" /> Audit event</span>
        <span class="success">Success</span>
      </div>
      <dl>
        <div>
          <dt>Action</dt>
          <dd>skill_retrieve</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>codex-desktop</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>openai / gpt-5.6</dd>
        </div>
        <div>
          <dt>Credential</dt>
          <dd>service-principal:review-bot</dd>
        </div>
        <div>
          <dt>Context</dt>
          <dd>project:nucleus</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>pr-review@2.4.1</dd>
        </div>
      </dl>
      <div class="audit-footer">
        <span>request:req_8f30d2</span>
        <span>42 ms</span>
      </div>
    </div>
  </div>
</section>

<style>
  .security {
    border-block: 1px solid var(--sp-color-border);
    background: var(--sp-color-surface);
  }

  .security-inner {
    display: grid;
    width: min(100% - 2rem, 75rem);
    grid-template-columns: minmax(0, 1fr) minmax(24rem, 0.9fr);
    gap: clamp(3rem, 8vw, 7rem);
    align-items: center;
    margin: 0 auto;
    padding: clamp(5rem, 10vw, 8rem) 0;
  }

  .security-icon {
    display: grid;
    width: 3rem;
    height: 3rem;
    place-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .eyebrow {
    margin: var(--sp-space-5) 0 var(--sp-space-4);
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: clamp(2rem, 5vw, 3.6rem);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: -0.05em;
    line-height: 1.05;
    text-wrap: balance;
  }

  .lede {
    margin: var(--sp-space-5) 0 var(--sp-space-6);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-4);
    line-height: 1.7;
  }

  ul {
    display: grid;
    gap: var(--sp-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    gap: var(--sp-space-3);
    align-items: flex-start;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: 1.45;
  }

  li :global(svg) {
    flex: 0 0 auto;
    margin-top: 0.15rem;
    color: var(--sp-color-success);
  }

  .audit-window {
    overflow: hidden;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-xl);
    background: var(--sp-color-canvas);
    box-shadow: var(--sp-shadow-lg);
  }

  .audit-header,
  .audit-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--sp-color-border);
    padding: var(--sp-space-4);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  .audit-header > span:first-child {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-2);
    color: var(--sp-color-text);
    font-weight: var(--sp-weight-semibold);
  }

  .success {
    border-radius: var(--sp-radius-round);
    padding: 0.25rem 0.5rem;
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-semibold);
  }

  dl {
    margin: 0;
    padding: var(--sp-space-2) var(--sp-space-4);
  }

  dl div {
    display: grid;
    grid-template-columns: 7rem 1fr;
    gap: var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
    padding: var(--sp-space-4) 0;
  }

  dl div:last-child {
    border-bottom: 0;
  }

  dt,
  dd {
    margin: 0;
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
  }

  dt {
    color: var(--sp-color-text-subtle);
  }

  dd {
    overflow-wrap: anywhere;
    color: var(--sp-color-text);
  }

  .audit-footer {
    border-top: 1px solid var(--sp-color-border);
    border-bottom: 0;
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  @media (max-width: 52rem) {
    .security-inner {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 30rem) {
    dl div {
      grid-template-columns: 1fr;
      gap: var(--sp-space-1);
    }
  }
</style>
