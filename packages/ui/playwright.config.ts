import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: "disabled",
      maxDiffPixels: 0,
      threshold: 0.2,
    },
  },
  snapshotPathTemplate: "{testDir}/visual/__screenshots__/{arg}{ext}",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:5702",
    headless: true,
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm exec vite --config vite.config.ts",
    url: "http://127.0.0.1:5702",
    reuseExistingServer: false,
    timeout: 30_000,
  },
  reporter: [["line"]],
});
