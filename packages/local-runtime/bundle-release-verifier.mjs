import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const outfile = resolve(
  process.argv[2] ?? resolve(root, "release-artifacts/verify-npm-release-order.mjs"),
);

await build({
  entryPoints: [resolve(root, "scripts/verify-npm-release-order.mjs")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
});
