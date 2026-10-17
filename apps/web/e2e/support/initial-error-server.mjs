import next from "next";
// Test-only server: exercise the real App Router error boundary without connecting to a database.
import { copyFile, cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const webDir = fileURLToPath(new URL("../../", import.meta.url));
const workDir = `${webDir}/tmp/e2e-error-${process.pid}`;
await mkdir(workDir, { recursive: true });
// Copy the real sources and share dependencies; isolate Next's generated files and lock.
await cp(`${webDir}/src`, `${workDir}/src`, { recursive: true });
await symlink(`${webDir}/node_modules`, `${workDir}/node_modules`, "dir");
await copyFile(`${webDir}/package.json`, `${workDir}/package.json`);
await writeFile(
  `${workDir}/tsconfig.json`,
  JSON.stringify({
    extends: "../../tsconfig.json",
    include: ["next-env.d.ts", ".next/types/**/*.ts", "src/**/*.ts", "src/**/*.tsx"],
  }),
);
await writeFile(
  `${workDir}/next.config.mjs`,
  `
  import config from ${JSON.stringify(new URL("../../next.config.mjs", import.meta.url).href)};
  export default { ...config, distDir: ".next" };
`,
);
process.env.DATABASE_URL = "";
process.env.UPTO_WEB_USE_FIXTURE_DATA = "false";
const app = next({ dev: true, dir: workDir, hostname: "127.0.0.1" });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((request, response) => handle(request, response));
server.on("upgrade", app.getUpgradeHandler());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.send({ type: "ready", port: server.address().port });
process.on("message", (message) => {
  if (message === "recover") {
    process.env.UPTO_WEB_USE_FIXTURE_DATA = "true";
    process.send({ type: "recovered" });
  }
});
process.on("SIGTERM", async () => {
  server.closeAllConnections();
  server.close();
  await app.close();
  await rm(workDir, { recursive: true, force: true });
  process.exit(0);
});
