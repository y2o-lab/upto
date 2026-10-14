import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadWorker() {
  const context = vm.createContext({
    crypto: webcrypto,
    Request,
    Response,
    URL,
    TextEncoder,
    Uint8Array,
  });
  const workerModule = new vm.SourceTextModule(
    await readFile(new URL("./control.mjs", import.meta.url), "utf8"),
    { context },
  );
  const platform = new vm.SyntheticModule(
    ["DurableObject", "WorkflowEntrypoint"],
    function () {
      this.setExport("DurableObject", class {});
      this.setExport("WorkflowEntrypoint", class {});
    },
    { context },
  );
  await workerModule.link(() => platform);
  await workerModule.evaluate();
  return workerModule.namespace;
}

const keyText = "fixture-only-bootstrap-key-32-bytes-long";
const nonce = "a".repeat(64);
async function signature(direction, key = keyText) {
  const cryptoKey = await webcrypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Buffer.from(
    await webcrypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(`${direction}\n${nonce}`),
    ),
  ).toString("hex");
}

function request(signatureValue, query = `nonce=${nonce}`) {
  return new Request(`https://fixture.workers.dev/__bootstrap/secret-retention?${query}`, {
    headers: { "x-bootstrap-signature": signatureValue },
  });
}

test("bootstrap refuses all collector entrypoints", async () => {
  const exports = await loadWorker();
  assert.equal(
    (await exports.default.fetch(new Request("https://fixture.workers.dev/api/v1/discovery"), {}))
      .status,
    503,
  );
  assert.equal((await new exports.CapacityGate().fetch()).status, 503);
  assert.equal((await new exports.GeminiGate().fetch()).status, 503);
  await assert.rejects(new exports.FeedWorkflow().run(), /runtime not installed/);
  await assert.rejects(new exports.ArticleWorkflow().run(), /runtime not installed/);
  await assert.rejects(exports.default.scheduled(), /runtime not installed/);
  let retries = 0;
  await exports.default.queue({
    retryAll() {
      retries += 1;
    },
  });
  assert.equal(retries, 1);
});

test("only the signed bootstrap probe receives a key-retention proof", async () => {
  const exports = await loadWorker();
  const env = { COLLECTOR_BOOTSTRAP_PROBE_KEY: keyText };
  const reply = await exports.default.fetch(request(await signature("request")), env);
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("cache-control"), "no-store");
  assert.equal((await reply.json()).proof, await signature("response"));
  for (const req of [
    request("f".repeat(64)),
    request("malformed"),
    request(await signature("request"), `nonce=${nonce}&extra=1`),
    request(await signature("request"), `nonce=${nonce}&nonce=${nonce}`),
  ]) {
    assert.equal((await exports.default.fetch(req, env)).status, 401);
  }
  assert.equal((await exports.default.fetch(request(await signature("request")), {})).status, 503);
  assert.equal(
    (
      await exports.default.fetch(request(await signature("request")), {
        COLLECTOR_BOOTSTRAP_PROBE_KEY: "short",
      })
    ).status,
    503,
  );
});
