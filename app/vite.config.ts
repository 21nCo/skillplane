import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";

// The SSR build resolves yaml's "node" export, a CommonJS build that requires
// `process` at module load and stops the whole Worker on workerd. Use the
// package's default entry instead: the same parser, as edge-safe ESM.
const yamlEsm = join(
  dirname(
    createRequire(new URL("../packages/domain/package.json", import.meta.url)).resolve(
      "yaml/package.json",
    ),
  ),
  "browser/index.js",
);

// Rolldown emits this helper in an SSR chunk. Workers have no import.meta.url
// for bundled modules, so createRequire needs a stable filename at the app's
// deployed bundle location rather than the filesystem root.
const cloudflareCreateRequire = {
  name: "cloudflare-create-require-url",
  apply: "build" as const,
  generateBundle(
    _options: unknown,
    bundle: Record<string, { type: string; code?: string }>,
  ) {
    for (const chunk of Object.values(bundle)) {
      if (
        chunk.type === "chunk" &&
        chunk.code?.includes("createRequire(import.meta.url)")
      ) {
        chunk.code = chunk.code.replaceAll(
          "createRequire(import.meta.url)",
          'createRequire(import.meta.url || "file:///app/.svelte-kit/cloudflare/_worker.js")',
        );
      }
    }
  },
};

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), cloudflareCreateRequire],
  resolve: {
    alias: [{ find: /^yaml$/, replacement: yamlEsm }],
  },
  server: {
    host: "127.0.0.1",
    port: 5700,
    strictPort: true,
  },
});
