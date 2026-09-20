#!/usr/bin/env node

import { deployDevelopmentTopology } from "./lib/development-topology-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";

export { deployDevelopmentTopology };

if (isMain(import.meta.url)) {
  const onlyIndex = process.argv.indexOf("--only");
  const onlyKinds =
    onlyIndex < 0 ? undefined : (process.argv[onlyIndex + 1] ?? "").split(",");
  process.stdout.write(
    `${JSON.stringify(await deployDevelopmentTopology({ onlyKinds }), null, 2)}\n`,
  );
}
