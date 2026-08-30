#!/usr/bin/env node

import {
  activeWorkerVersion,
  capture,
  isMain,
  productionReleaseTag,
  productionSecrets,
  requireCleanSourceRevision,
  requireEnvironment,
  requirePostHogProjectToken,
  requireSecretEnvironment,
  root,
  run,
  validateVersionId,
  withSecretFile,
} from "./lib/production-deployment.mjs";
import {
  ensureCloudflareSession,
  verifyPrivateProductionBucket,
  verifyProductionHyperdriveById,
} from "./lib/cloudflare-production.mjs";
import {
  productionTopologyDatabases,
  readAndAssertTopologySafety,
} from "./lib/production-topology-safety.mjs";
import { productionReleaseSmoke } from "./production-smoke.mjs";
import { renderTopologyDeploymentConfigs } from "./render-topology-config.mjs";

function routingKeys() {
  const value = requireEnvironment("WORKSPACE_ROUTING_KEYS", {
    minimumLength: 32,
    trim: false,
  });
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WORKSPACE_ROUTING_KEYS must be a JSON object");
  }
  return value;
}

function secretsFor(output) {
  if (output.kind === "projection") return null;
  const shared = {
    OAUTH_TOKEN_PEPPER: requireSecretEnvironment("OAUTH_TOKEN_PEPPER"),
    WORKSPACE_ROUTING_KEYS: routingKeys(),
  };
  if (output.id === "gateway:app") return { ...productionSecrets(), ...shared };
  if (output.id === "gateway:mcp") {
    return { ...shared, POSTHOG_PROJECT_TOKEN: requirePostHogProjectToken() };
  }
  return shared;
}

function worker(output) {
  return {
    name: output.config.name,
    directory: `${root}/${output.directory}`,
    config: `${root}/${output.path}`,
  };
}

export function deployedVersionFromOutput(output, label = "Wrangler deployment") {
  const match = /Current Version ID:\s*([a-f0-9-]{36})/iu.exec(output);
  return validateVersionId(match?.[1], `${label} uploaded version`);
}

async function waitForUploadedVersion(output, uploadedVersion) {
  let activeVersion = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    activeVersion = activeWorkerVersion(worker(output));
    if (activeVersion === uploadedVersion) return uploadedVersion;
    if (attempt < 30) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  const observed = activeVersion ?? "none";
  throw new Error(
    `${output.id} uploaded version is not serving at 100% (observed ${observed})`,
  );
}

function deployOutput(output, tag, secrets) {
  const operation = async (secretFile) => {
    const args = [
      "exec",
      "wrangler",
      "deploy",
      "--config",
      `${root}/${output.path}`,
      "--strict",
      "--message",
      `Skillplane multi-cell release ${tag}`,
      "--tag",
      tag,
    ];
    if (secretFile) args.push("--secrets-file", secretFile);
    const result = capture("pnpm", args, {
      cwd: `${root}/${output.directory}`,
      failureMessage: `${output.id} deployment failed`,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const uploadedVersion = deployedVersionFromOutput(
      `${result.stdout}\n${result.stderr}`,
      output.id,
    );
    await waitForUploadedVersion(output, uploadedVersion);
    return {
      id: output.id,
      name: output.config.name,
      version: uploadedVersion,
    };
  };
  return secrets ? withSecretFile(secrets, operation) : operation();
}

function hyperdriveId(config, binding) {
  const id = config.hyperdrive?.find((item) => item.binding === binding)?.id;
  if (!id) throw new Error(`Generated topology omitted ${binding}`);
  return id;
}

function verifyTopologyHyperdrives(rendered, databases) {
  const gateway = rendered.outputs.find((output) => output.id === "gateway:app");
  if (!gateway) throw new Error("Generated topology omitted the app gateway");
  const control = verifyProductionHyperdriveById(
    hyperdriveId(gateway.config, rendered.manifest.controlPlane.databaseBinding),
    databases.control.identity,
    "Topology control Hyperdrive",
  );
  const cells = Object.fromEntries(
    rendered.manifest.cells.map((cell) => {
      const output = rendered.outputs.find(
        (candidate) => candidate.id === `${cell.regionId}:app`,
      );
      if (!output) throw new Error(`Generated topology omitted ${cell.regionId}:app`);
      return [
        cell.regionId,
        verifyProductionHyperdriveById(
          hyperdriveId(output.config, cell.databaseBinding),
          databases.cells[cell.regionId].identity,
          `${cell.regionId} topology Hyperdrive`,
        ),
      ];
    }),
  );
  return { control, cells };
}

function verifyTopologyBuckets(rendered) {
  const names = new Set(
    rendered.outputs.flatMap((output) =>
      (output.config.r2_buckets ?? []).map((binding) => binding.bucket_name),
    ),
  );
  return [...names].sort().map((name) => verifyPrivateProductionBucket(name));
}

function verifyActiveTopologyWorkers(outputs, expectedDeployments) {
  return outputs.map((output) => {
    if (
      output.kind === "projection" &&
      !output.config.triggers?.crons?.includes("* * * * *")
    ) {
      throw new Error(`${output.id} does not have the required projection cron`);
    }
    const version = validateVersionId(
      activeWorkerVersion(worker(output)),
      `${output.id} active version`,
    );
    const expectedVersion = expectedDeployments.get(output.id);
    if (expectedVersion && version !== expectedVersion) {
      throw new Error(`${output.id} no longer serves the uploaded version`);
    }
    return {
      id: output.id,
      name: output.config.name,
      version,
    };
  });
}

export async function deployTopology(options = {}) {
  const sourceRevision = requireCleanSourceRevision();
  ensureCloudflareSession();
  const rendered = await renderTopologyDeploymentConfigs();
  const databases = productionTopologyDatabases(rendered.manifest);
  const safety = await readAndAssertTopologySafety({
    manifest: rendered.manifest,
    databases,
    sourceRevision,
  });
  const hyperdrives = verifyTopologyHyperdrives(rendered, databases);
  const buckets = verifyTopologyBuckets(rendered);
  const only = options.only;
  const selected = rendered.outputs.filter((output) => !only || output.kind === only);
  // Resolve every secret before the first Worker mutation so a late missing
  // gateway secret cannot leave a partially deployed topology.
  const secrets = new Map(selected.map((output) => [output.id, secretsFor(output)]));
  run("pnpm", ["build"], { failureMessage: "Production monorepo build failed" });
  // Private cells and projectors must exist before the public gateways bind them.
  selected.sort(
    (left, right) =>
      Number(left.id.startsWith("gateway:")) - Number(right.id.startsWith("gateway:")),
  );
  const tag = productionReleaseTag();
  const deployments = [];
  for (const output of selected) {
    deployments.push(await deployOutput(output, tag, secrets.get(output.id)));
  }
  // Re-read every active version after all uploads. This includes the private
  // projection workers and proves the cron-bearing versions are serving before
  // the public release smoke can mark the topology successful.
  const activeWorkers = verifyActiveTopologyWorkers(
    rendered.outputs,
    new Map(deployments.map((deployment) => [deployment.id, deployment.version])),
  );
  const smoke = await productionReleaseSmoke({ attempts: 90 });
  return {
    ok: true,
    tag,
    applicationCommit: sourceRevision.commit,
    safety: {
      backupCreatedAt: {
        control: safety.backups.control.createdAt,
        cells: Object.fromEntries(
          Object.entries(safety.backups.cells).map(([regionId, backup]) => [
            regionId,
            backup.createdAt,
          ]),
        ),
      },
      migrationCreatedAt: safety.migration.createdAt,
      ownership: safety.ownership,
    },
    resources: { hyperdrives, buckets },
    deployments,
    workers: activeWorkers,
    smoke,
  };
}

if (isMain(import.meta.url)) {
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
  if (only && !["app", "mcp", "projection"].includes(only)) {
    throw new Error("--only must be app, mcp, or projection");
  }
  process.stdout.write(`${JSON.stringify(await deployTopology({ only }), null, 2)}\n`);
}
