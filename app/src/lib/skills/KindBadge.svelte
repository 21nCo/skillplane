<script lang="ts">
  import { Badge } from "@skillplane/ui";
  import type { SkillKind } from "./types.js";

  let { kind }: { kind: SkillKind } = $props();
</script>

<span class="kind" data-artifact-kind={kind}>
  <Badge tone={kind === "instructions" ? "info" : "accent"}>
    {kind === "instructions" ? "Instructions" : "Skill"}
  </Badge>
</span>

<style>
  .kind {
    display: inline-flex;
  }
</style>
