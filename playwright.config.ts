import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/web/e2e",
  testIgnore: "**/visual/**",
  forbidOnly: Boolean(process.env.CI),
  globalTimeout: 10 * 60 * 1_000,
  workers: process.env.CI ? 2 : "50%",
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  webServer: {
    command: "pnpm --filter @upto/web exec next dev --hostname 127.0.0.1",
    env: { UPTO_WEB_USE_FIXTURE_DATA: "true" },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    url: "http://127.0.0.1:3000",
  },
  use: {
    baseURL: "http://127.0.0.1:3000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
