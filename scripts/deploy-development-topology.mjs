#!/usr/bin/env node

import { deployDevelopmentTopology } from "./lib/development-topology-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";

export { deployDevelopmentTopology };

export function parseOnlyKinds(args) {
  const onlyIndex = args.indexOf("--only");
  const onlyKinds = onlyIndex < 0 ? undefined : (args[onlyIndex + 1] ?? "").split(",");
  const allowed = new Set(["app", "mcp", "projection", "datafn"]);
  if (
    onlyKinds &&
    (onlyKinds.length === 0 || onlyKinds.some((kind) => !allowed.has(kind)))
  ) {
    throw new Error("--only must contain app, mcp, projection, or datafn");
  }
  return onlyKinds;
}

if (isMain(import.meta.url)) {
  const onlyKinds = parseOnlyKinds(process.argv.slice(2));
  process.stdout.write(
    `${JSON.stringify(await deployDevelopmentTopology({ onlyKinds }), null, 2)}\n`,
  );
}
