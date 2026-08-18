import { defineConfig } from "@trigger.dev/sdk";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// Trigger.dev 4.4.6 starts its managed index worker with only the project's
// runtime environment variables. It deliberately omits the CLI-only
// TRIGGER_PROJECT_REF, even though it re-imports this config. The controller
// already has the real project ref; the worker only needs a schema-valid value
// to discover task metadata.
const isManagedIndexWorker =
  process.env.TRIGGER_INDEXING === "1" &&
  typeof process.env.TRIGGER_BUILD_MANIFEST_PATH === "string";
const project = process.env.TRIGGER_PROJECT_REF;
const localCaRelativePath = "certs/inoue-coolify-local-ca.pem";
const localCaContainerPath = `/app/${localCaRelativePath}`;

if (!project && !isManagedIndexWorker) {
  throw new Error("TRIGGER_PROJECT_REF is required for Trigger.dev commands.");
}

export default defineConfig({
  build: {
    // jsdom reads non-JavaScript assets from its own package at runtime.
    // Bundling it makes its asset lookup resolve to /browser/... instead of
    // node_modules/jsdom/lib/jsdom/browser/..., so keep it as a Node module.
    external: ["jsdom"],
    extensions: [
      {
        name: "local-ca-for-trigger-4-4-6",
        async onBuildComplete(context, manifest) {
          if (context.target !== "deploy") {
            return;
          }

          const caOutputPath = join(manifest.outputPath, localCaRelativePath);
          await mkdir(dirname(caOutputPath), { recursive: true });
          await copyFile(join(context.workingDir, localCaRelativePath), caOutputPath);

          context.addLayer({
            build: {
              env: {
                NODE_EXTRA_CA_CERTS: localCaContainerPath,
              },
            },
            id: "local-ca-for-trigger-4-4-6",
          });
        },
      },
    ],
  },
  dirs: ["./apps/collector/src/trigger"],
  extraCACerts: "./certs/inoue-coolify-local-ca.pem",
  runtime: "node-22",
  maxDuration: 7_200,
  project: project || "trigger-indexing-only",
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
