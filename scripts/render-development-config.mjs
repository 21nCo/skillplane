#!/usr/bin/env node

import { renderDevelopmentConfigs } from "./lib/development-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";

export { renderDevelopmentConfigs };

if (isMain(import.meta.url)) {
  const result = await renderDevelopmentConfigs();
  process.stdout.write(
    `${JSON.stringify({ ...result, configs: Object.keys(result.configs) }, null, 2)}\n`,
  );
}
