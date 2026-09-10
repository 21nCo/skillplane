#!/usr/bin/env node

import { deployDevelopmentTopology } from "./lib/development-topology-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";

export { deployDevelopmentTopology };

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await deployDevelopmentTopology(), null, 2)}\n`,
  );
}
