import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "html"],
    },
    environment: "node",
    exclude: ["**/node_modules/**", "**/.git/**", "**/*.integration.test.ts"],
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts"],
  },
});
