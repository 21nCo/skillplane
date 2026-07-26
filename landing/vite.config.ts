import tailwindcss from "@tailwindcss/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __SKILLPLANE_BUILD_APP_ORIGIN__: JSON.stringify(
      process.env.SKILLPLANE_APP_ORIGIN ?? "https://app.skillplane.dev",
    ),
  },
  plugins: [tailwindcss(), sveltekit()],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
});
