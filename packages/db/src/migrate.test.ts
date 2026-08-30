import { describe, expect, it } from "vitest";
import { assertDisposableDatabaseUrl } from "./database-url.js";
import { loadMigrations, physicalOwnershipPlan } from "./migrate.js";

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
    ]);
    expect(new Set(migrations.map((migration) => migration.sha256)).size).toBe(
      migrations.length,
    );
    for (const migration of migrations) {
      expect(migration.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(migration.sql.trim().length).toBeGreaterThan(100);
      expect(migration.roles.length).toBeGreaterThan(0);
    }
    expect(migrations.at(-1)?.roles).toEqual(["combined", "regional"]);
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
