import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const collector = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(collector, "../..");
const output = resolve(collector, "build-node");
const routes = [
  "prepare",
  "discovery",
  "extract",
  "summarize-chunk",
  "merge-summary",
  "persist",
  "job-finalize",
  "manifests",
  "operation-status",
];
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: collector,
  entryPoints: routes.map((name) => `api/v1/${name}.ts`),
  outdir: output,
  outbase: ".",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "@google/genai",
    "@mozilla/readability",
    "fast-xml-parser",
    "jsdom",
    "p-limit",
    "zod",
    "pg-native",
  ],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  alias: {
    "@upto/db": resolve(root, "packages/db/src/index.ts"),
    "@upto/db/collector": resolve(root, "packages/db/src/collector/index.ts"),
    "@upto/domain": resolve(root, "packages/domain/src/index.ts"),
    "@upto/domain/batch": resolve(root, "packages/domain/src/batch/index.ts"),
  },
  metafile: true,
  write: true,
  sourcemap: false,
});
const artifacts = [];
for (const route of routes) {
  const path = resolve(output, `api/v1/${route}.mjs`);
  const data = await readFile(path);
  artifacts.push({
    route: `/api/v1/${route}`,
    file: `api/v1/${route}.mjs`,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  });
  const checked = spawnSync(
    process.execPath,
    [resolve(collector, "scripts/verify-node.mjs"), path, route],
    {
      env: process.env.PATH ? { PATH: process.env.PATH } : {},
      stdio: "pipe",
      timeout: 10000,
    },
  );
  if (checked.status !== 0) throw new Error("NODE_BUNDLE_IMPORT_FAILED");
}
const manifest = {
  schemaVersion: 1,
  artifacts,
  lockfileSha256: createHash("sha256")
    .update(await readFile(resolve(root, "pnpm-lock.yaml")))
    .digest("hex"),
};
await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(
  `Node bundle built and imported without credentials: ${routes.length} API routes\n`,
);
