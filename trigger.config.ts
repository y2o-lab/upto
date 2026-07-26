import { defineConfig } from "@trigger.dev/sdk";

const project = process.env.TRIGGER_PROJECT_REF;

if (!project) {
  throw new Error("TRIGGER_PROJECT_REF is required for Trigger.dev commands.");
}

export default defineConfig({
  dirs: ["./apps/collector/src/trigger"],
  project,
  retries: {
    default: {
      factor: 2,
      maxAttempts: 2,
      maxTimeoutInMs: 300_000,
      minTimeoutInMs: 30_000,
      randomize: true,
    },
    enabledInDev: false,
  },
  tsconfig: "./apps/collector/tsconfig.json",
});
