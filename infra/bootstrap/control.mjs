// Bootstrap-only module. This is not the collector runtime.
// Collector entrypoints refuse work; no external requests, DB writes, or permits.
import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
export class CapacityGate extends DurableObject {
  fetch() {
    return new Response("Collector paused", { status: 503 });
  }
}
export class GeminiGate extends DurableObject {
  fetch() {
    return new Response("Collector paused", { status: 503 });
  }
}
export class FeedWorkflow extends WorkflowEntrypoint {
  async run() {
    throw new Error("Collector runtime not installed");
  }
}
export class ArticleWorkflow extends WorkflowEntrypoint {
  async run() {
    throw new Error("Collector runtime not installed");
  }
}
// A separate bootstrap key proves retention without granting collector permissions.
// This endpoint has no business state or side effects and is removed by the real runtime.
async function probe(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/__bootstrap/secret-retention" || request.method !== "GET") {
    return new Response("Collector paused", { status: 503 });
  }
  const secret = env.COLLECTOR_BOOTSTRAP_PROBE_KEY;
  if (typeof secret !== "string" || new TextEncoder().encode(secret).length < 32) {
    return new Response("Collector paused", { status: 503 });
  }
  const nonce = url.searchParams.get("nonce");
  const signature = request.headers.get("x-bootstrap-signature");
  if (
    url.protocol !== "https:" ||
    [...url.searchParams.keys()].length !== 1 ||
    !/^[a-f0-9]{64}$/.test(nonce ?? "") ||
    !/^[a-f0-9]{64}$/.test(signature ?? "")
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const bytes = Uint8Array.from(signature.match(/../g), (byte) => Number.parseInt(byte, 16));
  if (
    !(await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(`request\n${nonce}`)))
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const proof = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`response\n${nonce}`)),
  );
  return Response.json(
    { proof: [...proof].map((byte) => byte.toString(16).padStart(2, "0")).join("") },
    { headers: { "cache-control": "no-store" } },
  );
}
export default {
  fetch: probe,
  async queue(batch) {
    batch.retryAll();
  },
  async scheduled() {
    throw new Error("Collector runtime not installed");
  },
};
