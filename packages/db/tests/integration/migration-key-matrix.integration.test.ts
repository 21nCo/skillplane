import { PostgresWorkspaceMigrationOperations } from "@skillplane/control-plane";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";

describe("workspace migration key matrix", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const names = [`matrix_source_${suffix}_test`, `matrix_target_${suffix}_test`];
  let admin: Pool;
  let source: Pool;
  let target: Pool;
  const objects = {
    read: async () => new Uint8Array(),
    put: async () => undefined,
    delete: async () => undefined,
  };

  beforeAll(async () => {
    const url = new URL(await resolveTestDatabaseUrl());
    url.pathname = "/postgres";
    admin = new Pool({ connectionString: url.toString() });
    const pools: Pool[] = [];
    for (const name of names) {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      url.pathname = `/${name}`;
      await migrateDatabase(url.toString());
      pools.push(new Pool({ connectionString: url.toString(), max: 5 }));
    }
    [source, target] = pools as [Pool, Pool];
  }, 90_000);

  afterAll(async () => {
    await Promise.all([source?.end(), target?.end()]);
    for (const name of names) {
      await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
    await admin?.end();
  });

  for (const scenario of [
    "fresh",
    "populated",
    "cached",
    "sequence-race",
    "cross-workspace",
    "shared-key",
    "tampered",
    "restart",
    "retry",
    "move-back",
    "descending",
    "large-integer",
    "cycling-sequence",
    "key-cycle",
  ] as const) {
    it(`preserves relationships and future inserts: ${scenario}`, async () => {
      const tag = scenario.replaceAll("-", "_");
      const parent = `matrix_parent_${tag}`;
      const child = `matrix_child_${tag}`;
      const workspace = `workspace:matrix-${tag}`;
      const context = {
        namespace: workspace,
        sourceRegionId: "legacy",
        targetRegionId: "in-south",
        sourceEpoch: 1,
        movingEpoch: 2,
      } as Parameters<PostgresWorkspaceMigrationOperations["quiesceSource"]>[0];
      let raced = false;
      const migrationTarget = {
        query: target.query.bind(target),
        async connect() {
          const client = await target.connect();
          return {
            async query<Row extends Record<string, unknown>>(
              sql: string,
              values?: readonly unknown[],
            ) {
              const result = await client.query<Row>(
                sql,
                values ? [...values] : undefined,
              );
              if (
                scenario === "sequence-race" &&
                !raced &&
                sql.includes(`last_value::text FROM "public"."${parent}_id_seq"`)
              ) {
                raced = true;
                const concurrent = await target.connect();
                try {
                  await concurrent.query("SET statement_timeout = '200ms'");
                  await expect(
                    concurrent.query(`SELECT nextval('"${parent}_id_seq"')`),
                  ).rejects.toMatchObject({ code: "57014" });
                } finally {
                  await concurrent.query("RESET statement_timeout");
                  concurrent.release();
                }
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      };
      const operations = new PostgresWorkspaceMigrationOperations(
        source,
        migrationTarget,
        source,
        objects,
        objects,
      );
      const ddl = `CREATE TABLE "${parent}" (
        id ${scenario === "cross-workspace" ? "bigint" : "bigserial"} PRIMARY KEY, __ns text NOT NULL, value text NOT NULL
      ); CREATE TABLE "${child}" (
        id bigserial PRIMARY KEY ${scenario === "shared-key" || scenario === "key-cycle" ? `REFERENCES "${parent}"(id)` : ""},
        __ns text NOT NULL, parent_id bigint REFERENCES "${parent}"(id), value text NOT NULL
      ); ${scenario === "cross-workspace" ? "" : `ALTER SEQUENCE "${parent}_id_seq" CACHE 10;`}
      ALTER SEQUENCE "${child}_id_seq" CACHE 10;`;
      const first =
        scenario === "large-integer"
          ? "9007199254740993"
          : scenario === "descending"
            ? "-1"
            : "1";
      const second =
        scenario === "large-integer"
          ? "9007199254740994"
          : scenario === "descending"
            ? "-2"
            : "2";
      let cached: PoolClient | undefined;
      let quiesced = false;
      try {
        await source.query(
          "INSERT INTO workspaces (id, workspace_id, slug, name) VALUES ($1, $1, $2, $2)",
          [workspace, tag.replaceAll("_", "-")],
        );
        await source.query(ddl);
        if (scenario !== "fresh") await target.query(ddl);
        if (scenario === "descending") {
          for (const pool of [source, target]) {
            for (const table of [parent, child]) {
              await pool.query(
                `ALTER SEQUENCE "${table}_id_seq" INCREMENT BY -1 MINVALUE -100000 MAXVALUE -1 START WITH -1 RESTART WITH -1`,
              );
            }
          }
        }
        await source.query(
          `INSERT INTO "${parent}" VALUES
          (${first}, $1, 'first'), (${second}, $1, 'second');`,
          [workspace],
        );
        await source.query(
          `INSERT INTO "${child}" VALUES
          (${first}, $1, ${first}, 'first child'), (${second}, $1, ${second}, 'second child')`,
          [workspace],
        );
        if (scenario !== "fresh") {
          await target.query(
            `INSERT INTO "${parent}" VALUES (${first}, 'other', 'existing')`,
          );
          await target.query(
            `INSERT INTO "${child}" VALUES (${first}, 'other', ${first}, 'existing child')`,
          );
        }
        if (
          scenario === "cached" ||
          scenario === "shared-key" ||
          scenario === "tampered"
        ) {
          cached = await target.connect();
          await cached.query(`SELECT nextval('"${parent}_id_seq"')`);
          await cached.query(`SELECT setval('"${child}_id_seq"', 100, true)`);
          await cached.query(`SELECT nextval('"${child}_id_seq"')`);
        }
        if (scenario === "cycling-sequence") {
          for (const pool of [source, target])
            await pool.query(`ALTER SEQUENCE "${parent}_id_seq" CYCLE`);
        }
        if (scenario === "key-cycle") {
          for (const pool of [source, target]) {
            await pool.query(
              `ALTER TABLE "${child}" ADD CONSTRAINT child_key_cycle FOREIGN KEY (id) REFERENCES "${parent}"(id)`,
            );
            await pool.query(
              `ALTER TABLE "${parent}" ADD CONSTRAINT parent_key_cycle FOREIGN KEY (id) REFERENCES "${child}"(id)`,
            );
          }
        }
        if (scenario === "cross-workspace") {
          await source.query(`UPDATE "${parent}" SET __ns = 'other' WHERE id = 1`);
        }
        await operations.quiesceSource(context);
        quiesced = true;
        await operations.drainOutboxes(context);
        if (scenario === "cycling-sequence" || scenario === "key-cycle") {
          await expect(operations.copyDatabase(context)).rejects.toThrow(
            scenario === "key-cycle"
              ? "WORKSPACE_MIGRATION_KEY_CYCLE_UNSUPPORTED"
              : "WORKSPACE_MIGRATION_CYCLING_SEQUENCE_UNSUPPORTED",
          );
          expect(
            (await target.query(`SELECT value FROM "${parent}" WHERE __ns = 'other'`))
              .rows,
          ).toEqual([{ value: "existing" }]);
          return;
        }
        if (scenario === "cross-workspace") {
          await expect(operations.copyDatabase(context)).rejects.toThrow(
            "WORKSPACE_MIGRATION_FOREIGN_KEY_INVALID",
          );
          return;
        }
        await operations.copyDatabase(context);
        if (scenario === "sequence-race") expect(raced).toBe(true);
        expect(
          (await operations.verifyDatabase(context)).every((check) => check.matched),
        ).toBe(true);
        if (scenario === "retry") {
          await operations.copyDatabase(context);
          expect(
            (await operations.verifyDatabase(context)).every((check) => check.matched),
          ).toBe(true);
        }
        if (scenario === "restart") {
          const checks = await operations.verifyDatabase(context);
          await source.query(
            `INSERT INTO workspace_migration_runs
            (id, workspace_id, source_region_id, target_region_id, source_epoch, final_epoch,
             status, phase, recovery_fence, evidence)
            VALUES ($1, $2, 'legacy', 'in-south', 1, 3, 'completed', 'complete', 1, $3::jsonb)`,
            [
              tag,
              workspace,
              JSON.stringify({
                workspaceId: workspace,
                targetRegionId: "in-south",
                finalEpoch: 3,
                checks,
              }),
            ],
          );
          const restarted = new PostgresWorkspaceMigrationOperations(
            source,
            target,
            source,
            objects,
            objects,
          );
          expect(
            (await restarted.verifyDatabase({ ...context, movingEpoch: 3 })).every(
              (check) => check.matched,
            ),
          ).toBe(true);
          // A different generation cannot reuse the recorded remapping proof.
          const stale = new PostgresWorkspaceMigrationOperations(
            source,
            target,
            source,
            objects,
            objects,
          );
          expect(
            (await stale.verifyDatabase({ ...context, movingEpoch: 5 })).some(
              (check) => !check.matched,
            ),
          ).toBe(true);
        }
        if (scenario === "move-back") {
          await operations.resumeTarget(context);
          const back = new PostgresWorkspaceMigrationOperations(
            target,
            source,
            source,
            objects,
            objects,
          );
          const backContext = {
            ...context,
            sourceRegionId: "in-south",
            targetRegionId: "legacy",
            sourceEpoch: 3,
            movingEpoch: 4,
          };
          await back.quiesceSource(backContext);
          try {
            await back.drainOutboxes(backContext);
            await back.copyDatabase(backContext);
            expect(
              (await back.verifyDatabase(backContext)).every((check) => check.matched),
            ).toBe(true);
            const links = await source.query(
              `SELECT c.value, p.value AS parent_value FROM "${child}" c
              JOIN "${parent}" p ON c.parent_id = p.id WHERE c.__ns = $1 ORDER BY c.value`,
              [workspace],
            );
            expect(links.rows).toEqual([
              { value: "first child", parent_value: "first" },
              { value: "second child", parent_value: "second" },
            ]);
            await back.resumeTarget(backContext);
          } catch (error) {
            await back.rollbackSource({ ...backContext, cause: error });
            throw error;
          }
        }
        const relationships = await target.query(
          `
          SELECT c.value, p.value AS parent_value,
                 (c.id = p.id) AS shared_key
          FROM "${child}" c JOIN "${parent}" p ON p.id = c.parent_id
          WHERE c.__ns = $1 ORDER BY c.value`,
          [workspace],
        );
        expect(relationships.rows.map((row) => [row.value, row.parent_value])).toEqual([
          ["first child", "first"],
          ["second child", "second"],
        ]);
        if (scenario === "shared-key") {
          expect(relationships.rows.every((row) => row.shared_key)).toBe(true);
        }
        if (scenario === "tampered") {
          await target.query(
            `UPDATE "${child}" SET parent_id =
            (SELECT id FROM "${parent}" WHERE __ns = $1 AND value = 'second')
            WHERE __ns = $1 AND value = 'first child'`,
            [workspace],
          );
          expect(
            (await operations.verifyDatabase(context)).some((check) => !check.matched),
          ).toBe(true);
        } else {
          // Exercise the original cached backend as well as a normal pool writer.
          const writer = cached ?? target;
          for (let index = 0; index < 25; index += 1) {
            const inserted = await writer.query(`INSERT INTO "${parent}" (__ns, value)
              VALUES ('future', 'future') RETURNING id`);
            await writer.query(
              `INSERT INTO "${child}" (${scenario === "shared-key" ? "id," : ""} __ns, parent_id, value)
              VALUES (${scenario === "shared-key" ? "$1," : ""} 'future', $1, 'future child')`,
              [inserted.rows[0].id],
            );
          }
        }
      } finally {
        cached?.release();
        if (quiesced) {
          await operations.rollbackSource({
            ...context,
            cause: new Error("matrix cleanup"),
          });
          expect(
            (
              await target.query(`SELECT id FROM "${parent}" WHERE __ns = $1`, [
                workspace,
              ])
            ).rows,
          ).toEqual([]);
          expect(
            (
              await source.query(
                `SELECT value FROM "${parent}" WHERE __ns = $1 ORDER BY value`,
                [workspace],
              )
            ).rows,
          ).toEqual(
            scenario === "cross-workspace"
              ? [{ value: "second" }]
              : [{ value: "first" }, { value: "second" }],
          );
        }
        for (const pool of [source, target]) {
          await pool.query(`DROP TABLE IF EXISTS "${child}", "${parent}" CASCADE`);
        }
      }
    }, 30_000);
  }
});
