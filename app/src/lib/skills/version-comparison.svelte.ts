import { getSkillDiff } from "./api.js";
import type { SkillVersion, SkillVersionDiff } from "./types.js";

/**
 * The default comparison runs forward in time: the current version against its base
 * or nearest older revision, or, for an initial version, against the newest later
 * revision. Returns null when there is nothing to compare.
 */
export function defaultComparison(
  versions: readonly SkillVersion[],
  current: SkillVersion | null,
): { readonly fromVersionId: string; readonly toVersionId: string } | null {
  const selected = current ?? versions.at(0);
  if (!selected) return null;
  const newestFirst = (left: SkillVersion, right: SkillVersion) =>
    right.revision - left.revision;
  const older =
    versions.find((version) => version.id === selected.baseVersionId) ??
    versions
      .filter((version) => version.revision < selected.revision)
      .sort(newestFirst)
      .at(0);
  if (older) return { fromVersionId: older.id, toVersionId: selected.id };
  const newer = versions
    .filter((version) => version.revision > selected.revision)
    .sort(newestFirst)
    .at(0);
  return newer ? { fromVersionId: selected.id, toVersionId: newer.id } : null;
}

/** Holds one artifact's diff result; only the latest comparison may set it. */
export class VersionComparison {
  diff = $state<SkillVersionDiff | null>(null);
  error = $state<string | null>(null);
  loading = $state(false);
  private request = 0;

  // Drops any comparison in flight, for example when another artifact is shown.
  reset(): void {
    this.request += 1;
    this.diff = null;
    this.error = null;
    this.loading = false;
  }

  async compare(options: {
    readonly workspaceId: string;
    readonly skillId: string;
    readonly fromVersionId: string;
    readonly toVersionId: string;
  }): Promise<void> {
    const request = ++this.request;
    this.loading = true;
    this.error = null;
    try {
      const diff = await getSkillDiff(options);
      if (request === this.request) this.diff = diff;
    } catch (cause) {
      if (request === this.request) {
        this.error =
          cause instanceof Error ? cause.message : "Versions could not be compared.";
      }
    } finally {
      if (request === this.request) this.loading = false;
    }
  }
}
