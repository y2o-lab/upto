import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e/visual",
  testMatch: "**/*.visual.spec.ts",
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: true,
  workers: 2,
  retries: 0,
  globalTimeout: 5 * 60 * 1_000,
  updateSnapshots: "none",
  snapshotPathTemplate: "{testDir}/snapshots/{projectName}/{arg}{ext}",
  outputDir: "test-results/visual",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/visual", open: "never" }]],
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
      maxDiffPixels: 0,
    },
  },
  webServer: {
    command: "pnpm --filter @upto/web exec next start --hostname 127.0.0.1 --port 3100",
    env: { UPTO_WEB_USE_FIXTURE_DATA: "true", DATABASE_URL: "", NEXT_TELEMETRY_DISABLED: "1" },
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 60_000,
  },
  use: {
    baseURL: "http://127.0.0.1:3100",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: (["light", "dark"] as const).flatMap((theme) => [
    {
      name: `desktop-${theme}`,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        colorScheme: theme,
      },
    },
    {
      name: `mobile-${theme}`,
      use: { ...devices["Pixel 7"], colorScheme: theme },
    },
  ]),
});
