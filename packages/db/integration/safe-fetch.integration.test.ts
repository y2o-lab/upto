import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { createSafeFetcher, requestPinned } from "../../../apps/collector/src/http/safe-fetch.js";
let directory: string;
let server: ReturnType<typeof createServer>;
let port: number;
let ca: string;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "upto-fetch-fixture-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=fixture.example",
      "-addext",
      "subjectAltName=DNS:fixture.example",
    ],
    { stdio: "ignore" },
  );
  ca = readFileSync(join(directory, "cert.pem"), "utf8");
  server = createServer(
    { key: readFileSync(join(directory, "key.pem")), cert: ca },
    (request, response) => {
      if (request.url === "/slow") {
        response.writeHead(200);
        response.flushHeaders();
      } else if (request.url === "/gzip") {
        response.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
        response.end(gzipSync("架空本文"));
      } else if (request.url === "/bomb") {
        response.writeHead(200, { "content-encoding": "gzip" });
        response.end(gzipSync("x".repeat(4096)));
      } else if (request.url === "/redirect") {
        response.writeHead(302, { location: "/gzip" });
        response.end();
      } else {
        response.writeHead(200);
        response.end("xxxx");
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  port = address.port;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (directory) rmSync(directory, { recursive: true, force: true });
});
function fetcher(maxBytes: number, timeoutMs = 20000, trusted = true) {
  return createSafeFetcher({
    maxBytes,
    timeoutMs,
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    connect: async (url, _address, signal, limit, headers) => {
      const fixture = new URL(url);
      fixture.port = String(port);
      // Transport injection maps validated public fixture IDs to a local TLS server. Production has no bypass endpoint.
      return requestPinned(
        fixture,
        { address: "127.0.0.1", family: 4 },
        signal,
        limit,
        headers,
        trusted ? ca : undefined,
      );
    },
  });
}
describe("native pinned HTTPS transport", () => {
  it("verifies the fixture certificate, follows a checked redirect and decodes gzip", async () => {
    expect(await (await fetcher(1024)("https://fixture.example/redirect")).text()).toBe("架空本文");
  });
  it("rejects compressed expansion and oversized raw responses", async () => {
    await expect(fetcher(1024)("https://fixture.example/bomb")).rejects.toThrow(
      "FETCH_BODY_TOO_LARGE",
    );
    await expect(fetcher(3)("https://fixture.example/raw")).rejects.toThrow("FETCH_BODY_TOO_LARGE");
  });
  it("aborts stalled native response bodies and sanitizes untrusted certificate errors", async () => {
    await expect(fetcher(1024, 100)("https://fixture.example/slow")).rejects.toThrow(
      "FETCH_TIMEOUT",
    );
    await expect(fetcher(1024, 20000, false)("https://fixture.example/gzip")).rejects.toThrow(
      "FETCH_TRANSPORT_FAILED",
    );
  });
});
