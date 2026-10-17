import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 393, height: 851 },
];

export default defineConfig({
  test: {
    projects: viewports.map(({ name, width, height }) => ({
      plugins: [
        storybookTest({
          configDir: fileURLToPath(new URL(".storybook", import.meta.url)),
          // The addon resets each story's viewport, so pin its global as well.
          initialGlobals: { viewport: { value: name, isRotated: false } },
        }),
      ],
      test: {
        name,
        browser: {
          enabled: true,
          headless: true,
          provider: playwright(),
          instances: [{ browser: "chromium", viewport: { width, height } }],
        },
      },
    })),
  },
});
