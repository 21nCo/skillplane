#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDevelopmentConfigs } from "./lib/development-deployment.mjs";

export { renderDevelopmentConfigs };

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await renderDevelopmentConfigs();
  process.stdout.write(
    `${JSON.stringify({ ...result, configs: Object.keys(result.configs) }, null, 2)}\n`,
  );
}
