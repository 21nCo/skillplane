#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isMain,
  portablePath,
  publicTurnstileSiteKey,
  requireHyperdriveId,
  root,
  sha256,
  workers,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";

const templateDirectory = resolve(root, "deployment", "wrangler");

async function readTemplate(name) {
  return JSON.parse(
    await readFile(resolve(templateDirectory, `${name}.production.json`), "utf8"),
  );
}

function runtimeConfig(template, hyperdriveId, variables = {}) {
  return {
    ...template,
    hyperdrive: [{ binding: "HYPERDRIVE", id: hyperdriveId }],
    vars: {
      ...template.vars,
      ...variables,
    },
  };
}

function validateRenderedConfig(name, config, hyperdriveId) {
  const serialized = JSON.stringify(config);
  const route = config.routes?.[0];
  const routeIsValid =
    name === "landing"
      ? route?.pattern === `${workers[name].host}/*` &&
        route.zone_name === workers[name].host &&
        route.custom_domain === undefined
      : route?.pattern === workers[name].host && route.custom_domain === true;
  if (
    config.name !== workers[name].name ||
    config.workers_dev !== false ||
    config.routes?.length !== 1 ||
    !routeIsValid ||
    /placeholder|replace[-_ ]?me|your[-_ ]?(?:id|key|token)/iu.test(serialized)
  ) {
    throw new Error(`The ${name} production template violates the deployment contract`);
  }
  if (name !== "landing") {
    if (
      config.hyperdrive?.length !== 1 ||
      config.hyperdrive[0]?.binding !== "HYPERDRIVE" ||
      config.hyperdrive[0]?.id !== hyperdriveId ||
      config.r2_buckets?.[0]?.bucket_name !== "skillplane-skill-bundles"
    ) {
      throw new Error(`The ${name} production binding inventory is incomplete`);
    }
    if (
      name === "app" &&
      (config.send_email?.[0]?.name !== "SEND_EMAIL" ||
        config.vars?.AUTH_MODE !== "otp")
    ) {
      throw new Error("The app production email binding is incomplete");
    }
    if (
      name === "mcp" &&
      (config.send_email !== undefined ||
        !config.rules?.some(
          (rule) =>
            rule.type === "Data" &&
            rule.globs?.includes("**/*.png") &&
            rule.globs?.includes("**/*.ico"),
        ) ||
        "AUTH_MODE" in (config.vars ?? {}) ||
        "EMAIL_PROVIDER" in (config.vars ?? {}) ||
        "PUBLIC_TURNSTILE_SITE_KEY" in (config.vars ?? {}) ||
        "TURNSTILE_ALLOWED_HOSTNAMES" in (config.vars ?? {}) ||
        "SKILLPLANE_OTP_FROM" in (config.vars ?? {}))
    ) {
      throw new Error("The MCP Worker must not receive an email binding");
    }
  }
}

export async function renderDeploymentConfigs(options = {}) {
  const hyperdriveId = requireHyperdriveId(options.hyperdriveId);
  const siteKey = options.siteKey ?? publicTurnstileSiteKey();
  const templates = {
    app: runtimeConfig(await readTemplate("app"), hyperdriveId, {
      PUBLIC_TURNSTILE_SITE_KEY: siteKey,
    }),
    mcp: runtimeConfig(await readTemplate("mcp"), hyperdriveId),
    landing: await readTemplate("landing"),
  };
  for (const config of Object.values(templates)) {
    config.$schema = "../node_modules/wrangler/config-schema.json";
  }
  for (const [name, config] of Object.entries(templates)) {
    validateRenderedConfig(name, config, hyperdriveId);
  }
  if (options.write !== false) {
    for (const [name, config] of Object.entries(templates)) {
      await writeJsonAtomic(
        options.outputPaths?.[name] ?? workers[name].config,
        config,
        { mode: 0o600 },
      );
    }
  }
  return {
    ok: true,
    hyperdriveId,
    configs: Object.fromEntries(
      Object.entries(templates).map(([name, config]) => [
        name,
        {
          path: portablePath(options.outputPaths?.[name] ?? workers[name].config),
          sha256: sha256(JSON.stringify(config)),
          worker: config.name,
          host: workers[name].host,
          routing: {
            type: name === "landing" ? "zone-route" : "custom-domain",
            pattern: config.routes[0].pattern,
          },
        },
      ]),
    ),
  };
}

if (isMain(import.meta.url)) {
  const result = await renderDeploymentConfigs();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
