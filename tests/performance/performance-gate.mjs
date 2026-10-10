#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";
import {
  assertDisposableDatabaseUrl,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "../../packages/db/dist/src/index.js";
import { buildApiServices, createApiApp } from "../../packages/api/dist/index.js";
import {
  createSkillBundleFixture,
  seedTenantFixture,
  TestObjectStorage,
} from "../../packages/testing/dist/index.js";
import { writeAuditEvent } from "../../packages/observability/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const databaseName = "skillplane_performance_test";
const samplesPerTarget = 25;
const warmupSamples = 5;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

function summarize(values) {
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.round(Math.max(...values) * 100) / 100,
  };
}

async function measure(label, operation, thresholdMs) {
  for (let index = 0; index < warmupSamples; index += 1) await operation();
  const values = [];
  for (let index = 0; index < samplesPerTarget; index += 1) {
    const startedAt = performance.now();
    await operation();
    values.push(performance.now() - startedAt);
  }
  const summary = summarize(values);
  assert(
    summary.p95Ms < thresholdMs,
    `${label} p95 ${String(summary.p95Ms)}ms exceeds ${String(thresholdMs)}ms`,
  );
  return summary;
}

function deterministicMarkdown() {
  const bytes = Buffer.alloc(720 * 1024);
  let state = 0x9e3779b9;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return `# Load target\n\n${bytes.toString("base64")}\n`;
}

async function recreateDatabase(sourceUrl, targetUrl) {
  const source = new URL(sourceUrl);
  assert(
    ["127.0.0.1", "localhost", "::1"].includes(source.hostname),
    "Performance testing is restricted to local Postgres",
  );
  assertDisposableDatabaseUrl(targetUrl);
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({
    connectionString: adminUrl.toString(),
    application_name: "skillplane-performance-admin",
    max: 1,
  });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
  } finally {
    await admin.end();
  }
}

async function dropDatabase(sourceUrl) {
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({
    connectionString: adminUrl.toString(),
    application_name: "skillplane-performance-cleanup",
    max: 1,
  });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

async function requestOk(app, path, headers = {}) {
  const response = await app.request(path, { headers });
  assert(response.status === 200, `${path} returned ${String(response.status)}`);
  await response.arrayBuffer();
  return response;
}

function indexNames(plan) {
  const names = new Set();
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value["Index Name"] === "string") names.add(value["Index Name"]);
    for (const child of Object.values(value)) visit(child);
  };
  visit(plan);
  return [...names].sort();
}

const sourceUrl = await resolveTestDatabaseUrl();
const performanceUrl = new URL(sourceUrl);
performanceUrl.pathname = `/${databaseName}`;
assertDisposableDatabaseUrl(performanceUrl.toString());

let services;
let pool;
try {
  await recreateDatabase(sourceUrl, performanceUrl.toString());
  await migrateDatabase(performanceUrl.toString());
  const suffix = `performance-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const tenant = await seedTenantFixture(performanceUrl.toString(), suffix);
  const storage = new TestObjectStorage();
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: performanceUrl.toString(),
    SKILL_BUNDLES: storage,
  });
  pool = services.database.pool;
  const app = createApiApp({
    requestId: () => `req_perf_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
  const headers = {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": tenant.workspaceId,
  };
  const bundle = await createSkillBundleFixture({
    name: "Load target",
    slug: "load-target",
    description: "Large deterministic skill for release performance gates",
    tags: ["loadtarget", "performance"],
    skillMarkdown: deterministicMarkdown(),
  });
  const createdResponse = await app.request(
    `/api/v1/workspaces/${encodeURIComponent(tenant.workspaceId)}/skills`,
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        "idempotency-key": `performance-create-${suffix}`,
      },
      body: JSON.stringify({
        bundleBase64: Buffer.from(bundle).toString("base64"),
        visibility: "public",
      }),
    },
  );
  if (createdResponse.status !== 201) {
    throw new Error(`Scale skill creation failed: ${await createdResponse.text()}`);
  }
  const createdEnvelope = await createdResponse.json();
  const skill = createdEnvelope.data.skill;
  const version = createdEnvelope.data.version;

  await pool.query(
    `INSERT INTO skills (
       id, workspace_id, slug, name, description, tags, visibility,
       created_by_user_id, published_search_text
     )
     SELECT 'perf-skill:' || series::text, $1,
            'scale-' || lpad(series::text, 5, '0'),
            'Loadtarget scale skill ' || series::text,
            'Searchable performance fixture ' || series::text,
            ARRAY['loadtarget', 'scale'], 'private', $2,
            'loadtarget indexed guidance'
       FROM generate_series(1, 9998) AS series`,
    [tenant.workspaceId, tenant.userId],
  );
  await pool.query(
    `INSERT INTO skill_versions (
       id, workspace_id, skill_id, revision, semantic_version, status, source,
       content_digest, manifest, change_summary, created_by_actor_type,
       created_by_actor_id, r2_object_key, bundle_byte_size, published_at
     )
     SELECT 'perf-scale-version:' || series::text, $1,
            'perf-skill:' || series::text, 1, '1.0.0', 'published', 'import',
            'sha256:' || md5('scale-' || series::text) ||
              md5('scale-digest-' || series::text),
            jsonb_build_object(
              'formatVersion', 1, 'byteSize', 1, 'expandedByteSize', 1,
              'fileCount', 0, 'files', jsonb_build_array()
            ),
            'Scale published revision', 'system', 'system:performance-gate',
            'workspaces/' || $1 || '/skills/perf-skill:' || series::text ||
              '/bundles/sha256/' || md5('scale-' || series::text) ||
              md5('scale-digest-' || series::text) || '.zip',
            1, now()
       FROM generate_series(1, 9998) AS series`,
    [tenant.workspaceId],
  );
  await pool.query(
    `UPDATE skills
        SET current_published_version_id =
              'perf-scale-version:' || split_part(id, ':', 2),
            next_revision = 2
      WHERE workspace_id = $1 AND id LIKE 'perf-skill:%'`,
    [tenant.workspaceId],
  );

  await pool.query(
    `INSERT INTO skill_versions (
       id, workspace_id, skill_id, revision, semantic_version, status, source,
       content_digest, manifest, change_summary, created_by_actor_type,
       created_by_actor_id, base_version_id, proposed_bump, r2_object_key,
       bundle_byte_size
     )
     SELECT 'perf-version:' || series::text, $1, $2, series, NULL, 'draft',
            'human',
            'sha256:' || md5(series::text) || md5('digest-' || series::text),
            jsonb_build_object(
              'formatVersion', 1, 'byteSize', 1, 'expandedByteSize', 1,
              'fileCount', 0, 'files', jsonb_build_array()
            ),
            'Scale revision ' || series::text, 'user', $3, $4, 'patch',
            'workspaces/' || $1 || '/skills/' || $2 ||
              '/bundles/sha256/' || md5(series::text) ||
              md5('digest-' || series::text) || '.zip',
            1
       FROM generate_series(2, 100) AS series`,
    [tenant.workspaceId, skill.id, tenant.userId, version.id],
  );
  await pool.query("UPDATE skills SET next_revision = 101 WHERE id = $1", [skill.id]);

  await pool.query(
    `INSERT INTO skill_contexts (
       id, workspace_id, skill_id, slug, name, description
     )
     SELECT 'perf-context:' || series::text, $1, $2,
            'project-' || lpad(series::text, 3, '0'),
            'Project ' || series::text,
            'Context knowledge scale fixture'
       FROM generate_series(1, 100) AS series`,
    [tenant.workspaceId, skill.id],
  );

  await pool.query(
    `INSERT INTO audit_events (
       id, workspace_id, occurred_at, event_type, action, outcome,
       actor_type, actor_id, user_id, request_id, resource_type, resource_id,
       metadata, retention_class
     )
     SELECT 'audit:perf:' || series::text, $1::text,
            now() - ((series % 30)::text || ' days')::interval,
            'mcp.skill_retrieve.success', 'skill_retrieve', 'success',
            'user', $2::text, $2::text, 'request:perf:' || series::text,
            'skill_version', $3::text,
            jsonb_build_object(
              'channel', 'mcp', 'skillId', $4::text, 'versionId', $3::text,
              'latencyMs', 25 + (series % 20)
            ),
            'detailed_read_90d'
       FROM generate_series(1, 1000000) AS series`,
    [tenant.workspaceId, tenant.userId, version.id, skill.id],
  );

  await pool.query(
    `INSERT INTO analytics_daily_summary (
       workspace_id, day, skill_id, event_count, retrieval_count,
       unique_principal_count, latency_p50_ms, latency_p95_ms,
       current_version_retrieval_count, versioned_retrieval_count
     )
     SELECT $1, current_date - series, '', 33333, 33333, 1, 34.5, 44,
            33333, 33333
       FROM generate_series(0, 29) AS series`,
    [tenant.workspaceId],
  );
  await pool.query(
    `INSERT INTO analytics_daily_summary (
       workspace_id, day, skill_id, event_count, retrieval_count,
       unique_principal_count, latency_p50_ms, latency_p95_ms,
       current_version_retrieval_count, versioned_retrieval_count
     )
     SELECT $1, current_date - (series % 30),
            'perf-skill:' || series::text, 100, 100, 1, 30, 45, 100, 100
       FROM generate_series(1, 9998) AS series
     UNION ALL
     SELECT $1, current_date, $2, 100, 100, 1, 30, 45, 100, 100`,
    [tenant.workspaceId, skill.id],
  );
  await pool.query(
    `INSERT INTO analytics_daily_dimensions (
       workspace_id, day, skill_id, dimension_type, dimension_value,
       event_count, unique_principal_count
     )
     SELECT $1, current_date - series, '', 'tool', 'skill_retrieve',
            33333, 1
       FROM generate_series(0, 29) AS series`,
    [tenant.workspaceId],
  );
  await pool.query(
    `INSERT INTO analytics_rollup_runs (
       workspace_id, day, source_event_count, completed_at
     )
     SELECT $1, current_date - series, 33333, now()
       FROM generate_series(0, 29) AS series`,
    [tenant.workspaceId],
  );
  await pool.query(
    "ANALYZE skills, skill_versions, skill_contexts, audit_events, analytics_daily_summary, analytics_daily_dimensions",
  );

  const privateFilePath =
    `/api/v1/skills/${encodeURIComponent(skill.id)}/versions/` +
    `${encodeURIComponent(version.id)}/files/SKILL.md`;
  const publicFilePath =
    `/api/v1/skills/public/workspace-${suffix}/load-target/versions/` +
    `${encodeURIComponent(version.id)}/${encodeURIComponent(version.digest)}` +
    "/files/SKILL.md";
  const analyticsPath = `/api/v1/analytics/workspaces/${encodeURIComponent(tenant.workspaceId)}`;
  const searchPath = "/api/v1/skills/search?q=loadtarget&limit=20";
  const metadataPath = `/api/v1/skills/${encodeURIComponent(skill.id)}`;

  const metrics = {
    authenticatedSearch: await measure(
      "authenticated search",
      () => requestOk(app, searchPath, headers),
      500,
    ),
    skillMetadata: await measure(
      "skill metadata",
      () => requestOk(app, metadataPath, headers),
      500,
    ),
    auditWrite: await measure(
      "audit write",
      () =>
        writeAuditEvent(pool, {
          workspaceId: tenant.workspaceId,
          eventType: "performance.audit.write",
          action: "performance_gate",
          outcome: "success",
          actorType: "system",
          actorId: "system:performance-gate",
          requestId: `request:performance:${crypto.randomUUID()}`,
          channel: "system",
          retentionClass: "permanent",
        }),
      500,
    ),
    analytics: await measure(
      "analytics endpoint",
      () => requestOk(app, analyticsPath, headers),
      500,
    ),
    skillFile: await measure(
      "large skill retrieval",
      () => requestOk(app, privateFilePath, headers),
      1_000,
    ),
  };

  const privateFile = await app.request(privateFilePath, { headers });
  assert(
    privateFile.headers.get("cache-control") === "private, no-store",
    "Authorized mutable-visibility retrieval must be private, no-store",
  );
  const publicFile = await app.request(publicFilePath);
  assert(publicFile.status === 200, "Digest-addressed public file was unavailable");
  assert(
    publicFile.headers.get("cache-control") === "public, max-age=31536000, immutable",
    "Digest-addressed public files must be immutable",
  );
  const publicEtag = publicFile.headers.get("etag");
  assert(publicEtag, "Digest-addressed public file did not return an ETag");
  const revalidated = await app.request(publicFilePath, {
    headers: { "if-none-match": publicEtag },
  });
  assert(revalidated.status === 304, "Public file ETag did not produce a 304");

  const planQueries = {
    search: [
      `SELECT id FROM skills
        WHERE workspace_id = $1 AND archived_at IS NULL
          AND workspace_search_document @@ websearch_to_tsquery('simple', $2)
        ORDER BY id LIMIT 20`,
      [tenant.workspaceId, "loadtarget"],
    ],
    audit: [
      `SELECT id FROM audit_events
        WHERE workspace_id = $1 AND occurred_at >= now() - interval '30 days'
        ORDER BY occurred_at DESC, id DESC LIMIT 100`,
      [tenant.workspaceId],
    ],
    analytics: [
      `SELECT day FROM analytics_daily_summary
        WHERE workspace_id = $1 AND skill_id = $2
          AND day = current_date
        ORDER BY day`,
      [tenant.workspaceId, skill.id],
    ],
  };
  const queryPlans = {};
  for (const [name, [query, values]] of Object.entries(planQueries)) {
    const explained = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
      values,
    );
    const plan = explained.rows[0]["QUERY PLAN"];
    const indexes = indexNames(plan);
    assert(indexes.length > 0, `${name} query plan did not use an index`);
    queryPlans[name] = {
      indexes,
      planningTimeMs: plan[0]["Planning Time"],
      executionTimeMs: plan[0]["Execution Time"],
      plan,
    };
  }

  const requiredIndexes = [
    "skills_workspace_search_idx",
    "skill_versions_workspace_skill_revision_idx",
    "skill_contexts_workspace_skill_idx",
    "audit_events_workspace_filters_idx",
    "analytics_daily_summary_workspace_day_idx",
    "analytics_daily_dimensions_lookup_idx",
  ];
  const existingIndexes = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    [requiredIndexes],
  );
  const presentIndexes = existingIndexes.rows.map((row) => row.indexname).sort();
  assert(
    requiredIndexes.every((index) => presentIndexes.includes(index)),
    `Required indexes missing: ${requiredIndexes
      .filter((index) => !presentIndexes.includes(index))
      .join(", ")}`,
  );

  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM skills WHERE workspace_id = $1) AS skills,
       (SELECT count(*)::int FROM skill_versions WHERE skill_id = $2) AS versions,
       (SELECT count(*)::int FROM skill_contexts WHERE skill_id = $2) AS contexts,
       (SELECT count(*)::int FROM audit_events WHERE workspace_id = $1) AS audit_events`,
    [tenant.workspaceId, skill.id],
  );
  const scale = counts.rows[0];
  assert(scale.skills === 10_000, `Expected 10,000 skills, found ${scale.skills}`);
  assert(scale.versions === 100, `Expected 100 versions, found ${scale.versions}`);
  assert(scale.contexts === 100, `Expected 100 contexts, found ${scale.contexts}`);
  assert(
    scale.audit_events >= 1_000_000,
    `Expected at least 1,000,000 audit events, found ${scale.audit_events}`,
  );

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    database: databaseName,
    fixture: scale,
    bundle: {
      compressedBytes: bundle.byteLength,
      skillMarkdownBytes: Buffer.byteLength(deterministicMarkdown()),
    },
    thresholdsMs: {
      authenticatedMetadataP95: 500,
      largeSkillRetrievalP95: 1_000,
    },
    metrics,
    requiredIndexes: presentIndexes,
    queryPlans,
    cacheHeaders: {
      private: privateFile.headers.get("cache-control"),
      public: publicFile.headers.get("cache-control"),
      publicRevalidationStatus: revalidated.status,
    },
  };
  const reportDirectory = resolve(root, ".data", "reports");
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(reportDirectory, "performance-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await services?.datafn.close().catch(() => undefined);
  await services?.email?.close().catch(() => undefined);
  await services?.database.close().catch(() => undefined);
  if (pool && pool !== services?.database.pool) await pool.end().catch(() => undefined);
  await dropDatabase(sourceUrl).catch((error) => {
    process.stderr.write(`Performance database cleanup failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
