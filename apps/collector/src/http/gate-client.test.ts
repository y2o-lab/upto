import { createAuthenticator, type BatchEnvironment } from "@upto/domain/batch";
import { expect, it } from "vitest";

import { createGateClient } from "./gate-client.js";
const key = new TextEncoder().encode("fixture-gate-auth-material-not-a-secret-0001");
const request = {
  apiVersion: "v1" as const,
  environment: "staging" as const,
  action: "reserve" as const,
  operationKey: "a".repeat(64),
  apiAttempt: 1,
  reservationGeneration: 1,
  model: "fixture-model",
  inputTokens: 100,
  outputTokenLimit: 1000,
};
const signal = () => new AbortController().signal;
function client(fetcher: typeof fetch, environment: BatchEnvironment = "staging") {
  return createGateClient({
    origin: "https://control.fixture.example",
    environment,
    executorVersion: "1",
    keyId: "fixture",
    key,
    fetcher,
  });
}
it("signs the exact raw request with fresh nonces and sends no body secrets", async () => {
  const nonces = new Set<string>();
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
  const value = client(async (url, init) => {
    expect(String(url)).toBe("https://control.fixture.example/v1/gate/reserve");
    expect(init?.redirect).toBe("manual");
    const body = new Uint8Array(init?.body as Uint8Array);
    const headers = new Headers(init?.headers);
    await auth.verify({ method: "POST", url: String(url), body, headers });
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual(request);
    return Response.json({
      status: "reserved",
      permitId: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      quotaVersion: "1",
    });
  });
  expect((await value.reserve(request, signal())).status).toBe("reserved");
  await value.reserve(request, signal());
  expect(nonces.size).toBe(2);
});
it("rejects a foreign environment before sending", async () => {
  let calls = 0;
  const value = client(async () => {
    calls++;
    throw new Error("must not send");
  }, "production");
  await expect(value.reserve(request, signal())).rejects.toThrow("GATE_REQUEST_INVALID");
  expect(calls).toBe(0);
});
it("rejects redirects and HTTP failures without exposing response details", async () => {
  for (const response of [
    new Response("fixture-token", {
      status: 302,
      headers: { location: "https://other.fixture.example" },
    }),
    new Response("fixture-token", { status: 403 }),
  ]) {
    await expect(client(async () => response).reserve(request, signal())).rejects.toThrow(
      "GATE_HTTP_FAILED",
    );
  }
});
it("bounds streamed responses and rejects malformed or unknown fields", async () => {
  await expect(
    client(async () => new Response("x".repeat(32769))).reserve(request, signal()),
  ).rejects.toThrow("GATE_RESPONSE_TOO_LARGE");
  await expect(
    client(async () =>
      Response.json({
        status: "waiting",
        reason: "DAILY_QUOTA",
        nextEligibleAt: new Date().toISOString(),
        token: "fixture",
      }),
    ).reserve(request, signal()),
  ).rejects.toThrow("GATE_RESPONSE_INVALID");
  await expect(
    client(async () => new Response("fixture-not-json")).reserve(request, signal()),
  ).rejects.toThrow("GATE_RESPONSE_INVALID");
});
it("aborts a stalled stream and waits for cancellation to settle", async () => {
  let cancelled = false;
  const value = createGateClient({
    origin: "https://control.fixture.example",
    environment: "staging",
    executorVersion: "1",
    keyId: "fixture",
    key,
    timeoutMs: 30,
    fetcher: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await expect(value.reserve(request, signal())).rejects.toThrow("GATE_TIMEOUT");
  expect(cancelled).toBe(true);
});
it("fails closed on transport errors and validates config before use", async () => {
  await expect(
    client(async () => {
      throw new Error("fixture-private-token");
    }).reserve(request, signal()),
  ).rejects.toThrow("GATE_TRANSPORT_FAILED");
  for (const origin of [
    "http://remote.fixture.example",
    "https://user:password@control.fixture.example",
    "https://control.fixture.example/path",
    "https://control.fixture.example?token=fixture",
  ])
    expect(() =>
      createGateClient({
        origin,
        environment: "staging",
        executorVersion: "1",
        keyId: "fixture",
        key,
      }),
    ).toThrow("GATE_CONFIG_INVALID");
});
it("snapshots signing configuration so caller mutation cannot change the active key or environment", async () => {
  const auth = createAuthenticator({
    environment: "staging",
    direction: "node-to-cf",
    allowedExecutorVersions: ["1"],
    keys: new Map([["fixture", key]]),
    consumeNonce: async () => true,
  });
  const config = {
    origin: "https://control.fixture.example",
    environment: "staging" as BatchEnvironment,
    executorVersion: "1",
    keyId: "fixture",
    key: new Uint8Array(key),
    fetcher: (async (url, init) => {
      await auth.verify({
        method: "POST",
        url: String(url),
        body: new Uint8Array(init?.body as Uint8Array),
        headers: new Headers(init?.headers),
      });
      return Response.json({
        status: "waiting",
        reason: "QUOTA",
        nextEligibleAt: new Date().toISOString(),
      });
    }) as typeof fetch,
  };
  const value = createGateClient(config);
  config.environment = "production";
  config.executorVersion = "changed";
  config.keyId = "changed";
  config.key.fill(0);
  expect((await value.reserve(request, signal())).status).toBe("waiting");
});
