import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertDisposableDatabaseUrl, packageRoot } from "./database-url.js";
import {
  loadMigrations,
  parseWorkspaceRegions,
  physicalOwnershipPlan,
} from "./migrate.js";

describe("migration chain", () => {
  it("is ordered, hashed, and immutable by identity", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map((migration) => migration.id)).toEqual([
      "0001_authfn_core.sql",
      "0002_skillplane_domain.sql",
      "0003_integrity_search_retention.sql",
      "0004_fix_published_version_transition.sql",
      "0005_authfn_otp_api_keys.sql",
      "0006_tenancy_credentials.sql",
      "0007_invitation_concurrency.sql",
      "0008_skill_bundles_search.sql",
      "0009_contexts_notes.sql",
      "0010_amendments_reviews.sql",
      "0011_authfn_mcp_oauth.sql",
      "0012_service_principal_audit_identity.sql",
      "0013_organization_agent_attribution.sql",
      "0014_observability_analytics.sql",
      "0015_audit_redaction_hardening.sql",
      "0016_authfn_service_principal_keys.sql",
      "0017_public_stats_index.sql",
      "0018_public_stats_counter.sql",
      "0019_public_stats_counter_shards.sql",
      "0020_global_control_plane_regional_cells.sql",
      "0021_authfn_identity_placement.sql",
      "0022_global_public_stats_projection.sql",
      "0023_control_initial_workspace_placements.sql",
      "0024_regional_workspace_migration_cleanup.sql",
      "0025_control_projection_ordering.sql",
      "0026_control_topology_cutover_fence.sql",
      "0027_control_projection_workspace_slug.sql",
      "0028_regional_published_row_updates.sql",
      "0029_regional_workspace_migration_fence.sql",
      "0030_regional_workspace_migration_outbox_drain.sql",
      "0031_datafn_internal_workspace_migration_fence.sql",
      "0032_control_public_skill_heads.sql",
      "0033_regional_projection_sequences.sql",
      "0034_control_public_stats_checkpoints.sql",
      "0035_control_cutover_workspace_creation_fence.sql",
      "0036_control_steady_state_workspace_placement.sql",
      "0037_regional_workspace_generation_fence.sql",
      "0038_multi_region_safety_hardening.sql",
      "0039_regional_generation_safety_hardening.sql",
      "0040_control_plane_safety_followup.sql",
      "0041_regional_fence_lock_followup.sql",
      "0042_control_outbox_cutover_fence_followup.sql",
      "0043_control_placement_region_integrity_followup.sql",
    ]);
    expect(new Set(migrations.map((migration) => migration.sha256)).size).toBe(
      migrations.length,
    );
    for (const migration of migrations) {
      expect(migration.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(migration.sql.trim().length).toBeGreaterThan(100);
      expect(migration.roles.length).toBeGreaterThan(0);
    }
    expect(migrations.at(-1)?.roles).toEqual(["combined", "control"]);
  });

  it("guards destructive test reset targets", () => {
    expect(() =>
      assertDisposableDatabaseUrl(
        "postgresql://user:pass@127.0.0.1:5432/skillplane_test",
      ),
    ).not.toThrow();
    expect(() =>
      assertDisposableDatabaseUrl(
        "postgresql://user:pass@railway.example/skillplane_test",
      ),
    ).toThrow(/Refusing destructive reset/);
    expect(() =>
      assertDisposableDatabaseUrl("postgresql://user:pass@127.0.0.1:5432/skillplane"),
    ).toThrow(/Refusing destructive reset/);
  });

  it("parses the standalone control migration region list", () => {
    expect(parseWorkspaceRegions("in-south, us-east,eu-west")).toEqual([
      "in-south",
      "us-east",
      "eu-west",
    ]);
    expect(parseWorkspaceRegions(undefined)).toBeUndefined();
    expect(parseWorkspaceRegions("")).toBeUndefined();
    expect(parseWorkspaceRegions(" \t\n ")).toBeUndefined();
  });

  it("builds runtime dependencies before database entrypoints", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts["migrate"]).toMatch(
      /^pnpm run build:runtime-dependencies && pnpm run build && /u,
    );
    expect(manifest.scripts["verify"]).toMatch(
      /^pnpm run build:runtime-dependencies && pnpm run build && /u,
    );
    expect(manifest.scripts["build:runtime-dependencies"]).toBe(
      "pnpm --filter @skillplane/control-plane build",
    );
  });

  it("assigns dynamic DataFn tables to regional databases", () => {
    const dynamic = [
      "widgets_9f3a",
      'nested"records',
      "__datafn_permission_directory_outbox",
    ];
    const regional = physicalOwnershipPlan("regional", dynamic);
    const control = physicalOwnershipPlan("control", dynamic);

    expect(regional.expected).toEqual(
      expect.arrayContaining([
        "widgets_9f3a",
        'nested"records',
        "__datafn_permission_directory_outbox",
      ]),
    );
    expect(regional.unowned).not.toEqual(
      expect.arrayContaining(["widgets_9f3a", 'nested"records']),
    );
    expect(control.unowned).toEqual(
      expect.arrayContaining([
        "widgets_9f3a",
        'nested"records',
        "__datafn_permission_directory_outbox",
      ]),
    );
    expect(control.expected).not.toEqual(
      expect.arrayContaining(["widgets_9f3a", 'nested"records']),
    );
  });
});
