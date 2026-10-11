import { createAuthenticator, gateRequestSchema } from "@upto/domain/batch";
import { beforeAll, afterAll, expect, it } from "vitest";

import { createGateClient } from "../../../apps/collector/src/http/gate-client.js";
import { createCollectorServer } from "../../../apps/collector/src/http/node-adapter.js";
let server: ReturnType<typeof createCollectorServer>;
let origin: string;
let trapCalls = 0;
const key = new TextEncoder().encode("fixture-native-gate-key-not-a-secret-0001");
const permitId = crypto.randomUUID();
const nonces = new Set<string>();
const outcomes: string[] = [];
let timeoutSettled!: () => void;
let settlement: Promise<void>;
const reserve = (model = "fixture-model") => ({
  apiVersion: "v1" as const,
  action: "reserve" as const,
  environment: "staging" as const,
  operationKey: "a".repeat(64),
  apiAttempt: 1,
  reservationGeneration: 1,
  model,
  inputTokens: 100,
  outputTokenLimit: 1000,
});
beforeAll(async () => {
  settlement = new Promise<void>((resolve) => {
    timeoutSettled = resolve;
  });
  const auth = createAuthenticator({
    environment: "staging",
    direction: "node-to-cf",
    allowedExecutorVersions: ["1"],
    keys: new Map([["fixture", key]]),
    consumeNonce: async (input) => {
      if (nonces.has(input.nonce)) return false;
      nonces.add(input.nonce);
      return true;
    },
  });
  server = createCollectorServer(
    async (request) => {
      if (new URL(request.url).pathname === "/trap") {
        trapCalls++;
        return Response.json({ status: "reported" });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      try {
        await auth.verify({
          method: request.method,
          url: request.url,
          body,
          headers: request.headers,
        });
      } catch {
        return new Response(null, { status: 403 });
      }
      const input = gateRequestSchema.parse(JSON.parse(new TextDecoder().decode(body)));
      if (input.action === "reserve") {
        if (input.model === "fixture-redirect")
          return new Response(null, { status: 302, headers: { location: origin + "/trap" } });
        if (input.model === "fixture-large") return new Response("x".repeat(32769));
        if (input.model === "fixture-stall") {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener(
              "abort",
              () => {
                timeoutSettled();
                resolve();
              },
              { once: true },
            ),
          );
          return Response.json({
            status: "waiting",
            reason: "FIXTURE_WAIT",
            nextEligibleAt: new Date().toISOString(),
          });
        }
        return Response.json({
          status: "reserved",
          permitId,
          expiresAt: new Date(Date.now() + 5000).toISOString(),
          quotaVersion: "1",
        });
      }
      if (input.action === "consume")
        return Response.json({ status: "consumed", permitId: input.permitId });
      outcomes.push(input.outcome);
      return Response.json({ status: "reported" });
    },
    () => origin,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});
function client(timeoutMs = 10000) {
  return createGateClient({
    origin,
    environment: "staging",
    executorVersion: "1",
    keyId: "fixture",
    key,
    timeoutMs,
  });
}
it("uses real HTTP and fresh signed nonces for reserve, consume and report", async () => {
  const value = client();
  const signal = new AbortController().signal;
  expect(await value.reserve(reserve(), signal)).toMatchObject({ status: "reserved", permitId });
  expect(
    await value.consume(
      {
        apiVersion: "v1",
        environment: "staging",
        action: "consume",
        operationKey: "a".repeat(64),
        apiAttempt: 1,
        permitId,
      },
      signal,
    ),
  ).toEqual({ status: "consumed", permitId });
  expect(
    await value.report(
      {
        apiVersion: "v1",
        environment: "staging",
        action: "report",
        operationKey: "a".repeat(64),
        apiAttempt: 1,
        permitId,
        outcome: "succeeded",
        inputTokens: 100,
        outputTokens: 20,
      },
      signal,
    ),
  ).toEqual({ status: "reported" });
  expect(outcomes).toEqual(["succeeded"]);
  expect(nonces.size).toBe(3);
});
it("does not follow redirects or accept oversized native responses", async () => {
  await expect(
    client().reserve(reserve("fixture-redirect"), new AbortController().signal),
  ).rejects.toThrow("GATE_HTTP_FAILED");
  expect(trapCalls).toBe(0);
  await expect(
    client().reserve(reserve("fixture-large"), new AbortController().signal),
  ).rejects.toThrow("GATE_RESPONSE_TOO_LARGE");
});
it("aborts stalled native HTTP and waits for the server invocation to settle", async () => {
  await expect(
    client(100).reserve(reserve("fixture-stall"), new AbortController().signal),
  ).rejects.toThrow("GATE_TIMEOUT");
  await settlement;
});
