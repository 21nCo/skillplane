import { build } from "esbuild";
import { chmodSync } from "node:fs";
await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/skillplane.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  conditions: ["development"],
  banner: {
    js: "import { createRequire as skillplaneCreateRequire } from 'node:module'; const require = skillplaneCreateRequire(import.meta.url);",
  },
});
chmodSync("dist/skillplane.mjs", 0o755);
