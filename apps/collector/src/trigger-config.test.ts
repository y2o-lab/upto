import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

type BuildExtension = {
  name: string;
  onBuildComplete?: (
    context: { addLayer: (layer: unknown) => void; target: string },
    manifest: unknown,
  ) => Promise<void> | void;
};

type TriggerConfig = {
  build?: { extensions?: BuildExtension[]; external?: string[] };
  maxDuration: number;
  tsconfig: string;
};

describe("Trigger.dev configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("allows each collector task attempt to run for up to two hours", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "proj_test");

    const configUrl = new URL("../trigger.config.ts", import.meta.url);
    const { default: config } = (await import(configUrl.href)) as {
      default: TriggerConfig;
    };

    expect(config.maxDuration).toBe(7_200);
  });

  it("keeps jsdom external so its runtime CSS assets remain available", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "proj_test");

    const configUrl = new URL("../trigger.config.ts", import.meta.url);
    const { default: config } = (await import(configUrl.href)) as {
      default: TriggerConfig;
    };

    expect(config.build?.external).toContain("jsdom");
  });

  it("uses a Trigger-specific TypeScript configuration", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "proj_test");

    const configUrl = new URL("../trigger.config.ts", import.meta.url);
    const { default: config } = (await import(configUrl.href)) as {
      default: TriggerConfig;
    };

    expect(config.tsconfig).toBe("./trigger.tsconfig.json");
  });

  it("writes jsdom as an external dependency in the deploy bundle", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "proj_test");

    const collectorDirectory = fileURLToPath(new URL("../", import.meta.url));
    const outputDirectory = await mkdtemp(join(tmpdir(), "upto-trigger-bundle-"));
    const runtimeSecret = "test-runtime-secret-that-must-not-be-in-the-image";
    const { buildWorker } = await import(
      new URL("../node_modules/trigger.dev/dist/esm/build/buildWorker.js", import.meta.url).href
    );
    const { loadConfig } = await import(
      new URL("../node_modules/trigger.dev/dist/esm/config.js", import.meta.url).href
    );
    const config = await loadConfig({
      configFile: "trigger.config.ts",
      cwd: collectorDirectory,
    });

    try {
      const manifest = await buildWorker({
        destination: outputDirectory,
        environment: "staging",
        envVars: {
          GEMINI_API_KEY: runtimeSecret,
        },
        forcedExternals: [],
        plain: true,
        resolvedConfig: config,
        rewritePaths: false,
        target: "deploy",
      });
      const packageJson = JSON.parse(
        await readFile(join(outputDirectory, "package.json"), "utf8"),
      ) as {
        dependencies: Record<string, string>;
      };
      const bundledFiles = await readdir(outputDirectory, { recursive: true });
      const bundledCode = await Promise.all(
        bundledFiles
          .filter((file) => file.endsWith(".mjs"))
          .map((file) => readFile(join(outputDirectory, file), "utf8")),
      );
      const buildManifest = JSON.parse(
        await readFile(join(outputDirectory, "build.json"), "utf8"),
      ) as { build: Record<string, never>; deploy: Record<string, never> };

      expect(manifest.externals).toContainEqual({ name: "jsdom", version: "29.1.1" });
      expect(packageJson.dependencies.jsdom).toBe("29.1.1");
      expect(bundledCode.join("\n")).not.toContain("default-stylesheet.css");
      expect(bundledCode.join("\n")).not.toContain(runtimeSecret);
      expect(buildManifest.deploy).toEqual({});
      expect(buildManifest.build).toEqual({});
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });

  it("allows the isolated managed index worker to reload the config", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "");
    vi.stubEnv("TRIGGER_INDEXING", "1");
    vi.stubEnv("TRIGGER_BUILD_MANIFEST_PATH", "./build.json");

    const configUrl = new URL("../trigger.config.ts", import.meta.url);
    const { default: config } = (await import(configUrl.href)) as {
      default: TriggerConfig & { project: string };
    };

    expect(config.project).toBe("trigger-indexing-only");
  });

  it("still requires the project ref outside the managed index worker", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "");

    const configUrl = new URL("../trigger.config.ts", import.meta.url);

    await expect(import(configUrl.href)).rejects.toThrow(
      "TRIGGER_PROJECT_REF is required for Trigger.dev commands.",
    );
  });

  it("supplies the private CA to the Trigger.dev 4.4.6 image build", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "proj_test");

    const configUrl = new URL("../trigger.config.ts", import.meta.url);
    const { default: config } = (await import(configUrl.href)) as {
      default: TriggerConfig;
    };
    const extension = config.build?.extensions?.find(
      (candidate) => candidate.name === "local-ca-for-trigger-4-4-6",
    );
    const layers: unknown[] = [];
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "upto-trigger-config-"));
    const sourceDirectory = join(temporaryDirectory, "apps", "collector");
    const outputDirectory = join(temporaryDirectory, "output");

    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(join(temporaryDirectory, "certs"), { recursive: true });
    await writeFile(join(temporaryDirectory, "certs", "inoue-coolify-local-ca.pem"), "test-ca");

    try {
      await extension?.onBuildComplete?.(
        {
          addLayer: (layer: unknown) => layers.push(layer),
          config: { project: "proj_test" },
          target: "deploy",
          workingDir: sourceDirectory,
        } as never,
        { outputPath: outputDirectory } as never,
      );

      await expect(
        readFile(join(outputDirectory, "certs", "inoue-coolify-local-ca.pem"), "utf8"),
      ).resolves.toBe("test-ca");
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }

    expect(layers).toEqual([
      {
        build: {
          env: {
            NODE_EXTRA_CA_CERTS: "/app/certs/inoue-coolify-local-ca.pem",
          },
        },
        id: "local-ca-for-trigger-4-4-6",
      },
    ]);
  });

  it("preserves the CA extension when the CLI explicitly loads the TypeScript config", async () => {
    vi.stubEnv("TRIGGER_PROJECT_REF", "proj_test");

    const { loadConfig } = await import(
      new URL("../node_modules/trigger.dev/dist/esm/config.js", import.meta.url).href
    );
    const config = await loadConfig({
      configFile: "trigger.config.ts",
      cwd: fileURLToPath(new URL("../", import.meta.url)),
    });

    expect(config.runtime).toBe("node-22");
    expect(config.build.extensions?.map((extension: { name: string }) => extension.name)).toContain(
      "local-ca-for-trigger-4-4-6",
    );
  });

  it("runs each Trigger.dev command from the collector package", async () => {
    const collectorPackageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const collectorPackageJson = JSON.parse(await readFile(collectorPackageJsonPath, "utf8")) as {
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const rootPackageJsonPath = fileURLToPath(new URL("../../../package.json", import.meta.url));
    const rootPackageJson = JSON.parse(await readFile(rootPackageJsonPath, "utf8")) as {
      scripts: Record<string, string>;
    };

    for (const scriptName of [
      "trigger:deploy:dry-run",
      "trigger:deploy:prod",
      "trigger:deploy:staging",
      "trigger:dev",
    ]) {
      expect(collectorPackageJson.scripts[scriptName]).toContain("--config trigger.config.ts");
      expect(rootPackageJson.scripts[scriptName]).toBe(
        `pnpm --dir apps/collector run ${scriptName}`,
      );
    }

    for (const scriptName of [
      "trigger:deploy:dry-run",
      "trigger:deploy:prod",
      "trigger:deploy:staging",
    ]) {
      expect(collectorPackageJson.scripts[scriptName]).toContain("--network host");
      expect(collectorPackageJson.scripts[scriptName]).toContain("--builder trigger-host");
    }

    expect(collectorPackageJson.devDependencies["trigger.dev"]).toBe("4.4.6");
    expect(collectorPackageJson.devDependencies.typescript).toBe("5.9.3");
    expect(collectorPackageJson.scripts.typecheck).toContain("pnpm --dir ../.. exec tsc");
  });
});
