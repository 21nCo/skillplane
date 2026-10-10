<script lang="ts">
  let {
    width = "100%",
    height = "1rem",
    radius = "var(--sp-radius-sm)",
    label = "Loading",
  }: {
    width?: string;
    height?: string;
    radius?: string;
    label?: string;
  } = $props();
</script>

<span
  class="skeleton"
  role="status"
  aria-label={label}
  style:width
  style:height
  style:border-radius={radius}
></span>

<style>
  .skeleton {
    display: inline-block;
    max-width: 100%;
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
