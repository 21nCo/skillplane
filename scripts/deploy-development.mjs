#!/usr/bin/env node

import { deployDevelopment } from "./lib/development-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";

export { deployDevelopment };

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await deployDevelopment(), null, 2)}\n`);
}
