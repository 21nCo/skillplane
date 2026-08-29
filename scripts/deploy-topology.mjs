#!/usr/bin/env node

import {
  isMain,
  productionReleaseTag,
  productionSecrets,
  requireCleanSourceRevision,
  requireEnvironment,
  requirePostHogProjectToken,
  requireSecretEnvironment,
  root,
  run,
  withSecretFile,
} from "./lib/production-deployment.mjs";
import { ensureCloudflareSession } from "./lib/cloudflare-production.mjs";
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

function deployOutput(output, tag) {
  const operation = (secretFile) => {
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
    run("pnpm", args, {
      cwd: `${root}/${output.directory}`,
      failureMessage: `${output.id} deployment failed`,
    });
  };
  const secrets = secretsFor(output);
  return secrets ? withSecretFile(secrets, operation) : operation();
}

export async function deployTopology(options = {}) {
  requireCleanSourceRevision();
  ensureCloudflareSession();
  const rendered = await renderTopologyDeploymentConfigs();
  run("pnpm", ["build"], { failureMessage: "Production monorepo build failed" });
  const only = options.only;
  const selected = rendered.outputs.filter((output) => !only || output.kind === only);
  // Private cells and projectors must exist before the public gateways bind them.
  selected.sort(
    (left, right) =>
      Number(left.id.startsWith("gateway:")) - Number(right.id.startsWith("gateway:")),
  );
  const tag = productionReleaseTag();
  for (const output of selected) await deployOutput(output, tag);
  return { ok: true, tag, workers: selected.map((output) => output.id) };
}

if (isMain(import.meta.url)) {
  const onlyIndex = process.argv.indexOf("--only");
  const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
  if (only && !["app", "mcp", "projection"].includes(only)) {
    throw new Error("--only must be app, mcp, or projection");
  }
  process.stdout.write(`${JSON.stringify(await deployTopology({ only }), null, 2)}\n`);
}
