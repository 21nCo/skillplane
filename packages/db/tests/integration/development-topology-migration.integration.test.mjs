import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  loadMigrations,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "../../src/index.js";
import { packageRoot } from "../../src/database-url.js";
import { migrateDevelopmentTopology as migrateDevelopmentTopologyEntrypoint } from "../../../../scripts/migrate-development-topology.mjs";
import {
  accountListing,
  developmentAccountId,
  withDevelopmentCloudflare,
} from "../../../../scripts/lib/cloudflare-accounts-fixture.mjs";
import {
  verifyDevelopmentTopologyDatabaseOwnership,
  verifyDevelopmentTopologyDatabases,
} from "../../../../scripts/lib/development-topology-deployment.mjs";

// The entrypoint first verifies the development Cloudflare token's account
// scope. These tests supply the fixture variables and a stubbed single-account
// listing, so they need no Cloudflare credentials and make no network call.
// The fixture swaps process.env and fetch, so concurrent runs share one scope.
function withDevelopmentAccount(operation) {
  return withDevelopmentCloudflare(
    { fetch: accountListing([developmentAccountId]) },
    operation,
  );
}

function migrateDevelopmentTopology(options) {
  return withDevelopmentAccount(() => migrateDevelopmentTopologyEntrypoint(options));
}

// One control and two cell databases stand in for the development topology.
// The fixture rewinds them to the state observed on 2026-11-05: control before
// 0051 (so also without the later 0055) and cells at 0050, with the 0052-0054
// regional objects absent.
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const names = {
  control: `skillplane_devtopo_control_${suffix}_test`,
  "in-south": `skillplane_devtopo_insouth_${suffix}_test`,
  "us-east": `skillplane_devtopo_useast_${suffix}_test`,
  // Never migrated: a freshly provisioned database with no tables.
  empty: `skillplane_devtopo_empty_${suffix}_test`,
};
const urls = {};
let admin;
let migrations;

const controlRewound = [
  "0051_control_composition_visibility.sql",
  "0055_control_oauth_refresh_user_client_index.sql",
];
const cellsRewound = [
  "0052_regional_skill_groups.sql",
  "0053_regional_git_sources.sql",
  "0054_regional_artifact_kind.sql",
];

function database(label) {
  return {
    url: urls[label],
    fingerprint: `fixture-${label}`,
    identity: { database: names[label] },
  };
}

function topology(overrides = {}) {
  return {
    control: overrides.control ?? database("control"),
    cells: {
      "in-south": overrides["in-south"] ?? database("in-south"),
      "us-east": overrides["us-east"] ?? database("us-east"),
    },
  };
}

function head(role) {
  return migrations
    .filter((migration) => migration.roles.includes(role))
    .at(-1)
    .id.replace(/\.sql$/u, "");
}

async function withPool(label, operation) {
  const pool = new Pool({ connectionString: urls[label], max: 1 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}

async function ledger(label) {
  return withPool(label, async (pool) =>
    (
      await pool.query("SELECT id FROM skillplane_schema_migrations ORDER BY id")
    ).rows.map((row) => row.id),
  );
}

async function tables(label) {
  return withPool(label, async (pool) =>
    (
      await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name`,
      )
    ).rows.map((row) => row.table_name),
  );
}

// The converted topology that `db:prepare:dev:topology` leaves behind.
async function migrateToHead() {
  await migrateDatabase(urls.control, {
    role: "control",
    initialWorkspaceRegion: "in-south",
    workspaceRegions: ["in-south", "us-east"],
  });
  for (const label of ["in-south", "us-east"]) {
    await migrateDatabase(urls[label], { role: "regional" });
  }
}

// Brings every database to head, then reverses the rewound migrations so each
// test starts from the same behind-head state.
async function rewind() {
  await migrateToHead();
  const oauthIndexRollback = await readFile(
    resolve(
      packageRoot,
      "migrations",
      "rollback",
      "0055_control_oauth_refresh_user_client_index.sql",
    ),
    "utf8",
  );
  await withPool("control", (pool) => pool.query(oauthIndexRollback));
  await withPool("control", (pool) =>
    pool.query(`BEGIN;
      ALTER TABLE public_skill_version_lifecycle
        DROP CONSTRAINT public_skill_version_lifecycle_withdrawn_sequence_check,
        DROP COLUMN withdrawn_sequence;
      DELETE FROM skillplane_schema_migrations
       WHERE id = '0051_control_composition_visibility.sql';
      COMMIT;`),
  );
  const artifactKindRollback = await readFile(
    resolve(packageRoot, "migrations", "rollback", "0054_regional_artifact_kind.sql"),
    "utf8",
  );
  for (const label of ["in-south", "us-east"]) {
    await withPool(label, async (pool) => {
      await pool.query(artifactKindRollback);
      await pool.query(`BEGIN;
        DROP TABLE skill_version_git_provenance, skill_source_bindings,
          skill_source_runs, skill_sources;
        DROP FUNCTION skillplane_git_provenance_immutable(),
          skillplane_git_run_identity_immutable();
        DELETE FROM skillplane_schema_migrations
         WHERE id = '0053_regional_git_sources.sql';
        DROP TABLE skill_group_members, skill_group_skills, skill_groups;
        DELETE FROM skillplane_schema_migrations
         WHERE id = '0052_regional_skill_groups.sql';
        COMMIT;`);
    });
  }
}

beforeAll(async () => {
  migrations = await loadMigrations();
  const testUrl = new URL(await resolveTestDatabaseUrl());
  testUrl.pathname = "/postgres";
  admin = new Pool({ connectionString: testUrl.toString(), max: 1 });
  for (const [label, name] of Object.entries(names)) {
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    testUrl.pathname = `/${name}`;
    urls[label] = testUrl.toString();
  }
  await migrateToHead();
}, 180_000);

afterAll(async () => {
  for (const name of Object.values(names)) {
    await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  await admin?.end();
});

describe("development topology schema head", () => {
  it("reports SCHEMA_BEHIND for each database behind head instead of CELL_TABLE_MISSING", async () => {
    await rewind();
    // The ownership check alone only sees the missing table.
    await assert.rejects(
      verifyDevelopmentTopologyDatabaseOwnership(topology()),
      /^Error: CELL_TABLE_MISSING:in-south:skill_groups$/u,
    );
    await assert.rejects(verifyDevelopmentTopologyDatabases(topology()), (error) => {
      assert.equal(
        error.message,
        [
          `SCHEMA_BEHIND:control:0049_control_public_skill_lifecycle->${head("control")}`,
          `SCHEMA_BEHIND:in-south:0050_regional_verification_immutability->${head("regional")}`,
          `SCHEMA_BEHIND:us-east:0050_regional_verification_immutability->${head("regional")}`,
        ].join("; "),
      );
      return true;
    });
  });
});

describe("development topology migration", () => {
  it("migrates behind databases to head without dropping data, and a second run is a no-op", async () => {
    await rewind();
    await withPool("in-south", (pool) =>
      pool.query(
        `INSERT INTO skills (id, workspace_id, slug, name, visibility)
         VALUES ('kept-skill', 'kept-workspace', 'kept', 'Kept', 'public')`,
      ),
    );
    const before = {
      control: await tables("control"),
      "in-south": await tables("in-south"),
      "us-east": await tables("us-east"),
    };

    const first = await migrateDevelopmentTopology({ databases: topology() });
    assert.deepEqual(first.control.applied, controlRewound);
    assert.deepEqual(first.cells["in-south"].applied, cellsRewound);
    assert.deepEqual(first.cells["us-east"].applied, cellsRewound);
    assert.deepEqual(first.schema, {
      control: { head: head("control") },
      cells: {
        "in-south": { head: head("regional") },
        "us-east": { head: head("regional") },
      },
    });
    assert.ok(first.ownership.cells["us-east"].tableCount > 0);
    for (const [label, previous] of Object.entries(before)) {
      const after = await tables(label);
      assert.deepEqual(
        previous.filter((table) => !after.includes(table)),
        [],
        `${label} lost a table`,
      );
    }
    assert.deepEqual(
      await withPool(
        "in-south",
        async (pool) =>
          (await pool.query("SELECT id, kind FROM skills WHERE id = 'kept-skill'"))
            .rows,
      ),
      [{ id: "kept-skill", kind: "skill" }],
    );
    await verifyDevelopmentTopologyDatabaseOwnership(topology());

    const ledgers = {
      control: await ledger("control"),
      "in-south": await ledger("in-south"),
    };
    const second = await migrateDevelopmentTopology({ databases: topology() });
    assert.deepEqual(second.control.applied, []);
    assert.deepEqual(second.cells["in-south"].applied, []);
    assert.deepEqual(second.cells["us-east"].applied, []);
    assert.deepEqual(await ledger("control"), ledgers.control);
    assert.deepEqual(await ledger("in-south"), ledgers["in-south"]);
  });

  it("resumes an interrupted run and serializes racing runs", async () => {
    await rewind();
    const interrupted = migrateDevelopmentTopology({
      databases: topology(),
      async migrate(url, options) {
        if (url === urls["us-east"]) throw new Error("fixture interruption");
        return migrateDatabase(url, options);
      },
    });
    await assert.rejects(interrupted, /fixture interruption/u);
    const resumed = await migrateDevelopmentTopology({ databases: topology() });
    assert.deepEqual(resumed.control.applied, []);
    assert.deepEqual(resumed.cells["in-south"].applied, []);
    assert.deepEqual(resumed.cells["us-east"].applied, cellsRewound);

    await rewind();
    const racing = await withDevelopmentAccount(() =>
      Promise.all([
        migrateDevelopmentTopologyEntrypoint({ databases: topology() }),
        migrateDevelopmentTopologyEntrypoint({ databases: topology() }),
      ]),
    );
    for (const [label, expected] of [
      ["control", controlRewound],
      ["in-south", cellsRewound],
      ["us-east", cellsRewound],
    ]) {
      const applied = racing.flatMap((result) =>
        label === "control" ? result.control.applied : result.cells[label].applied,
      );
      assert.deepEqual(applied.sort(), expected, `${label} applied once`);
    }
  });

  it("refuses an unconverted topology before migrating any database", async () => {
    await rewind();
    const controlLedger = await ledger("control");
    const usEastLedger = await ledger("us-east");
    await assert.rejects(
      migrateDevelopmentTopology({
        databases: topology({ "in-south": database("control") }),
      }),
      /^Error: TOPOLOGY_NOT_PREPARED:in-south:authfn_users \(run pnpm db:prepare:dev:topology first\)$/u,
    );
    await assert.rejects(
      migrateDevelopmentTopology({
        databases: topology({ control: database("us-east") }),
      }),
      /^Error: TOPOLOGY_NOT_PREPARED:control:skills \(run pnpm db:prepare:dev:topology first\)$/u,
    );
    assert.deepEqual(await ledger("control"), controlLedger);
    assert.deepEqual(await ledger("us-east"), usEastLedger);
  });

  it("refuses an empty control or cell database before writing to any database", async () => {
    await rewind();
    const before = {
      control: await ledger("control"),
      "in-south": await ledger("in-south"),
      "us-east": await ledger("us-east"),
    };
    let migrations = 0;
    const migrate = async (url, options) => {
      migrations += 1;
      return migrateDatabase(url, options);
    };
    for (const [label, overrides] of [
      ["control", { control: database("empty") }],
      ["us-east", { "us-east": database("empty") }],
    ]) {
      await assert.rejects(
        migrateDevelopmentTopology({ databases: topology(overrides), migrate }),
        new RegExp(
          `^Error: TOPOLOGY_NOT_PREPARED:${label}:empty \\(run pnpm db:prepare:dev:topology first\\)$`,
          "u",
        ),
      );
      // No migration ledger or migration-created table was written.
      assert.deepEqual(await tables("empty"), []);
    }
    // A ledger left by a first run that never committed a migration is empty too.
    await withPool("empty", (pool) =>
      pool.query(`CREATE TABLE skillplane_schema_migrations (
        id text PRIMARY KEY, sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        execution_ms integer NOT NULL CHECK (execution_ms >= 0))`),
    );
    await assert.rejects(
      migrateDevelopmentTopology({
        databases: topology({ "in-south": database("empty") }),
        migrate,
      }),
      /^Error: TOPOLOGY_NOT_PREPARED:in-south:empty /u,
    );
    assert.deepEqual(await tables("empty"), ["skillplane_schema_migrations"]);
    assert.deepEqual(await ledger("empty"), []);
    await withPool("empty", (pool) =>
      pool.query("DROP TABLE skillplane_schema_migrations"),
    );

    assert.equal(migrations, 0);
    for (const [label, previous] of Object.entries(before)) {
      assert.deepEqual(await ledger(label), previous, `${label} was migrated`);
    }
  });
});
