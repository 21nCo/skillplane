<script lang="ts">
  import { resolve } from "$app/paths";
  import {
    ArrowRightIcon as ArrowRight,
    CheckCircleIcon as CheckCircle,
    GitBranchIcon as GitBranch,
    RobotIcon as Robot,
    SparkleIcon as Sparkle,
  } from "phosphor-svelte";
</script>

<section class="hero" aria-labelledby="hero-title">
  <div class="hero-grid" aria-hidden="true"></div>
  <div class="hero-glow" aria-hidden="true"></div>
  <div class="hero-copy">
    <a class="announcement" href={resolve("/skills")}>
      <Sparkle size={14} weight="fill" aria-hidden="true" />
      <span>Explore published skills</span>
      <ArrowRight size={14} aria-hidden="true" />
    </a>
    <h1 id="hero-title">Skills that improve<br />without losing control.</h1>
    <p class="lede">
      Create reusable AI skills, give them project context, and let agents propose
      evidence-backed improvements through MCP. Every approved change becomes a
      traceable version.
    </p>
    <div class="hero-actions">
      <a class="primary-action" href="https://app.skillplane.dev/sign-in?intent=signup">
        Create your first skill
        <ArrowRight size={16} aria-hidden="true" />
      </a>
      <a class="secondary-action" href={resolve("/skills")}>Browse public skills</a>
    </div>
    <p class="hero-note">Private by default · Human review · Complete provenance</p>
  </div>

  <div class="product-window" aria-label="Example Skillplane skill workflow">
    <div class="window-bar">
      <span class="window-brand">
        <span class="window-mark"
          ><Robot size={14} weight="fill" aria-hidden="true" /></span
        >
        pr-review
      </span>
      <span class="version-pill">
        <CheckCircle size={13} weight="fill" aria-hidden="true" />
        v2.4.1 published
      </span>
    </div>
    <div class="window-body">
      <aside aria-label="Example skill navigation">
        <p>Skill</p>
        <span class="active">Overview</span>
        <span>Content</span>
        <span>Versions</span>
        <span>Contexts</span>
        <span>Settings</span>
      </aside>
      <div class="skill-preview">
        <div class="preview-heading">
          <div>
            <p class="preview-label">Published skill</p>
            <h2>PR Review</h2>
          </div>
          <span class="public-pill">Public</span>
        </div>
        <p class="preview-copy">
          Review pull requests for correctness, security, maintainability, and test
          coverage.
        </p>
        <div class="context-row">
          <GitBranch size={17} aria-hidden="true" />
          <div>
            <strong>nucleus</strong>
            <span>12 context learnings · updated today</span>
          </div>
        </div>
        <div class="amendment">
          <div class="amendment-topline">
            <span>Agent amendment</span>
            <span class="review-pill">Review required</span>
          </div>
          <p>Add a check for session-composition interval regressions.</p>
          <div class="evidence">
            <span>3 files changed</span>
            <span>2 evidence links</span>
            <span>High confidence</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .hero {
    position: relative;
    overflow: hidden;
    border-bottom: 1px solid var(--sp-color-border);
    padding: clamp(5rem, 10vw, 8.5rem) 1rem 4.5rem;
    isolation: isolate;
  }

  .hero-grid {
    position: absolute;
    z-index: -2;
    inset: 0;
    background-image:
      linear-gradient(var(--sp-color-border) 1px, transparent 1px),
      linear-gradient(90deg, var(--sp-color-border) 1px, transparent 1px);
    background-size: 4rem 4rem;
    opacity: 0.24;
    mask-image: linear-gradient(to bottom, black, transparent 78%);
  }

  .hero-glow {
    position: absolute;
    z-index: -1;
    top: -20rem;
    left: 50%;
    width: min(78rem, 110vw);
    height: 45rem;
    transform: translateX(-50%);
    border-radius: 50%;
    background: color-mix(in srgb, var(--sp-color-accent) 22%, transparent);
    filter: blur(90px);
    opacity: 0.72;
  }

  .hero-copy {
    width: min(100%, 61rem);
    margin: 0 auto;
    text-align: center;
  }

  .announcement {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-2);
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-round);
    padding: 0.4rem 0.7rem;
    background: color-mix(in srgb, var(--sp-color-surface-raised) 85%, transparent);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    text-decoration: none;
    box-shadow: var(--sp-shadow-sm);
  }

  .announcement :global(svg:first-child) {
    color: var(--sp-color-accent);
  }

  h1 {
    margin: 1.75rem 0 0;
    color: var(--sp-color-text);
    font-size: clamp(3rem, 8vw, 6.8rem);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: -0.065em;
    line-height: 0.94;
    text-wrap: balance;
  }

  .lede {
    max-width: 46rem;
    margin: 1.75rem auto 0;
    color: var(--sp-color-text-muted);
    font-size: clamp(1rem, 2vw, 1.2rem);
    line-height: 1.65;
    text-wrap: balance;
  }

  .hero-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--sp-space-3);
    margin-top: var(--sp-space-8);
  }

  .primary-action,
  .secondary-action {
    display: inline-flex;
    min-height: 2.75rem;
    align-items: center;
    justify-content: center;
    gap: var(--sp-space-2);
    border-radius: var(--sp-radius-md);
    padding: 0 var(--sp-space-5);
    font-size: var(--sp-font-size-4);
    font-weight: var(--sp-weight-semibold);
    text-decoration: none;
  }

  .primary-action {
    background: var(--sp-color-text);
    color: var(--sp-color-canvas);
    box-shadow: var(--sp-shadow-md);
  }

  .secondary-action {
    border: 1px solid var(--sp-color-border-strong);
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
  }

  .hero-note {
    margin: var(--sp-space-4) 0 0;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .product-window {
    width: min(100%, 68rem);
    margin: 5rem auto 0;
    overflow: hidden;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-xl);
    background: var(--sp-color-surface);
    box-shadow: var(--sp-shadow-lg);
    text-align: left;
  }

  .window-bar {
    display: flex;
    min-height: 3.25rem;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--sp-color-border);
    padding: 0 var(--sp-space-4);
    background: var(--sp-color-surface-raised);
  }

  .window-brand,
  .version-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-2);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
  }

  .window-mark {
    display: grid;
    width: 1.65rem;
    height: 1.65rem;
    place-items: center;
    border-radius: var(--sp-radius-sm);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .version-pill {
    color: var(--sp-color-success);
  }

  .window-body {
    display: grid;
    grid-template-columns: 12rem 1fr;
    min-height: 28rem;
  }

  aside {
    display: flex;
    flex-direction: column;
    gap: var(--sp-space-1);
    border-right: 1px solid var(--sp-color-border);
    padding: var(--sp-space-5) var(--sp-space-3);
    background: var(--sp-color-canvas);
  }

  aside p {
    margin: 0 0 var(--sp-space-2);
    padding: 0 var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  aside span {
    border-radius: var(--sp-radius-md);
    padding: 0.5rem var(--sp-space-2);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  aside .active {
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text);
    font-weight: var(--sp-weight-medium);
  }

  .skill-preview {
    padding: clamp(1.5rem, 4vw, 3rem);
  }

  .preview-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
  }

  .preview-label {
    margin: 0 0 var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-medium);
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: clamp(1.5rem, 4vw, 2.25rem);
    letter-spacing: -0.035em;
  }

  .public-pill,
  .review-pill {
    border-radius: var(--sp-radius-round);
    padding: 0.28rem 0.55rem;
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-semibold);
    white-space: nowrap;
  }

  .preview-copy {
    max-width: 37rem;
    margin: var(--sp-space-3) 0 var(--sp-space-8);
    color: var(--sp-color-text-muted);
    line-height: 1.6;
  }

  .context-row {
    display: flex;
    align-items: center;
    gap: var(--sp-space-3);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-canvas);
    color: var(--sp-color-accent-text);
  }

  .context-row div {
    display: grid;
    gap: var(--sp-space-1);
  }

  .context-row strong {
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-4);
  }

  .context-row span {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .amendment {
    margin-top: var(--sp-space-4);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
  }

  .amendment-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-4);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-medium);
  }

  .review-pill {
    background: var(--sp-color-warning-soft);
    color: var(--sp-color-warning);
  }

  .amendment p {
    margin: var(--sp-space-4) 0;
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-4);
  }

  .evidence {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-3);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  @media (max-width: 40rem) {
    .hero {
      padding-top: 4rem;
    }

    h1 {
      font-size: clamp(2.75rem, 13vw, 4rem);
    }

    .hero-actions {
      display: grid;
    }

    .window-body {
      display: block;
      min-height: 0;
    }

    aside {
      display: none;
    }

    .product-window {
      margin-top: 3.5rem;
    }

    .window-bar {
      padding: 0 var(--sp-space-3);
    }

    .window-brand {
      max-width: 8rem;
    }

    .skill-preview {
      padding: var(--sp-space-5);
    }

    .amendment-topline {
      align-items: flex-start;
      flex-direction: column;
      gap: var(--sp-space-2);
    }
  }
</style>
