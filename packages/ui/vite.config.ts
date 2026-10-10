import tailwindcss from "@tailwindcss/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "static",
  plugins: [tailwindcss(), svelte()],
  server: {
    host: "127.0.0.1",
    port: 5702,
    strictPort: true,
  },
});
