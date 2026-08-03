<script lang="ts">
  let {
    size = "1.75rem",
    radius = "0.45rem",
  }: {
    size?: string;
    radius?: string;
  } = $props();
</script>

<img
  class="brand-mark"
  src="/skillplane-logo.png"
  alt=""
  aria-hidden="true"
  draggable="false"
  width="512"
  height="512"
  style:width={size}
  style:height={size}
  style:border-radius={radius}
/>

<style>
  .brand-mark {
    display: block;
    flex: 0 0 auto;
    object-fit: cover;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--sp-color-border) 72%, transparent);
  }
</style>
