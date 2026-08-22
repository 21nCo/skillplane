#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deployDevelopment } from "./lib/development-deployment.mjs";

export { deployDevelopment };

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(await deployDevelopment(), null, 2)}\n`);
}
