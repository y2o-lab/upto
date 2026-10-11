import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "packages/db/integration/**/*.integration.test.ts",
      "apps/collector/integration/**/*.integration.test.ts",
    ],
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
