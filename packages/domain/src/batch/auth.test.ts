import { describe, expect, it } from "vitest";

import {
  createAuthenticator,
  signRequest,
  type AuthContext,
  type SignedRequestInput,
} from "./auth.js";

const time = 1791676800000;
const key = new TextEncoder().encode("fixture-key-material-never-a-real-secret-0001");
const oldKey = new TextEncoder().encode("fixture-key-material-never-a-real-secret-0002");
const context: AuthContext = {
  authVersion: "v1",
  direction: "cf-to-node",
  environment: "staging",
  keyId: "new",
  executorVersion: "build-new",
  requestId: "00000000-0000-4000-8000-000000000001",
  nonce: "00000000-0000-4000-8000-000000000002",
  issuedAt: time,
  expiresAt: time + 60000,
};
const request: SignedRequestInput = {
  method: "POST",
  url: "https://fixture.example/api/v1/extract",
  body: new TextEncoder().encode('{"generationId":"fixture"}'),
};
function receiver(now = time) {
  const nonces = new Set<string>();
  let writes = 0;
  const auth = createAuthenticator({
    environment: "staging",
    direction: "cf-to-node",
    allowedExecutorVersions: ["build-new", "build-old"],
    keys: new Map([
      ["new", key],
      ["old", oldKey],
    ]),
    now: () => now,
    consumeNonce: async (input) => {
      writes++;
      const id = [input.environment, input.direction, input.keyId, input.nonce].join(":");
      if (nonces.has(id)) return false;
      nonces.add(id);
      return true;
    },
  });
  return { auth, writes: () => writes };
}
async function signed(overrides: Partial<AuthContext> = {}, input = request, signingKey = key) {
  return signRequest(input, { ...context, ...overrides }, signingKey);
}
describe("direction-scoped raw request signatures", () => {
  it("accepts the signed raw body and consumes its nonce once", async () => {
    const { auth, writes } = receiver();
    const headers = await signed();
    expect(await auth.verify({ ...request, headers })).toEqual(context);
    await expect(auth.verify({ ...request, headers })).rejects.toMatchObject({
      code: "AUTH_REPLAY",
      status: 401,
    });
    expect(writes()).toBe(2);
  });
  it("rejects concurrent replay", async () => {
    const { auth } = receiver();
    const headers = await signed();
    const outcomes = await Promise.allSettled([
      auth.verify({ ...request, headers }),
      auth.verify({ ...request, headers }),
    ]);
    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
  });
  it.each([
    { body: new TextEncoder().encode('{ "generationId":"fixture"}') },
    { method: "GET" },
    { url: "https://fixture.example/api/v1/merge-summary" },
    { url: "https://fixture.example/api/v1/extract?extra=1" },
  ])("rejects raw body, method, path, and query tampering", async (changed) => {
    const { auth, writes } = receiver();
    await expect(
      auth.verify({ ...request, ...changed, headers: await signed() }),
    ).rejects.toThrow();
    expect(writes()).toBe(0);
  });
  it("canonicalizes query ordering while signing its values", async () => {
    const query = {
      method: "GET",
      url: "https://fixture.example/api/v1/manifests?manifestId=a&limit=1",
      body: new Uint8Array(),
    };
    const headers = await signed({}, query);
    const { auth } = receiver();
    expect(
      (
        await auth.verify({
          ...query,
          url: "https://fixture.example/api/v1/manifests?limit=1&manifestId=a",
          headers,
        })
      ).nonce,
    ).toBe(context.nonce);
    await expect(
      receiver().auth.verify({
        ...query,
        url: "https://fixture.example/api/v1/manifests?limit=2&manifestId=a",
        headers,
      }),
    ).rejects.toMatchObject({ code: "AUTH_SIGNATURE_INVALID" });
  });
  it("preserves duplicate query value order to avoid ambiguous first-value selection", async () => {
    const query = {
      method: "GET",
      url: "https://fixture.example/api/v1/manifests?a=1&a=2",
      body: new Uint8Array(),
    };
    const headers = await signed({}, query);
    await expect(
      receiver().auth.verify({
        ...query,
        url: "https://fixture.example/api/v1/manifests?a=2&a=1",
        headers,
      }),
    ).rejects.toMatchObject({ code: "AUTH_SIGNATURE_INVALID" });
  });
  it("accepts both rotation keys and retained executor versions", async () => {
    const headers = await signed({ keyId: "old", executorVersion: "build-old" }, request, oldKey);
    expect((await receiver().auth.verify({ ...request, headers })).keyId).toBe("old");
  });
  it("rejects unknown key, environment, direction, and deployment", async () => {
    for (const changed of [
      { keyId: "unknown" },
      { environment: "production" as const },
      { direction: "node-to-cf" as const },
      { executorVersion: "unexpected" },
    ]) {
      const requestInput = changed.direction
        ? { ...request, url: "https://fixture.example/v1/gate/reserve" }
        : request;
      const headers = await signed(changed, requestInput);
      await expect(receiver().auth.verify({ ...requestInput, headers })).rejects.toThrow();
    }
  });
  it("checks future issue skew and expiry grace at exact boundaries", async () => {
    const headers = await signed();
    expect((await receiver(time - 5000).auth.verify({ ...request, headers })).issuedAt).toBe(time);
    await expect(receiver(time - 5001).auth.verify({ ...request, headers })).rejects.toMatchObject({
      code: "AUTH_TIME_INVALID",
    });
    expect((await receiver(time + 64999).auth.verify({ ...request, headers })).expiresAt).toBe(
      time + 60000,
    );
    await expect(receiver(time + 65000).auth.verify({ ...request, headers })).rejects.toMatchObject(
      { code: "AUTH_TIME_INVALID" },
    );
  });
  it("refuses oversized bodies before consuming a nonce", async () => {
    const { auth, writes } = receiver();
    await expect(
      auth.verify({ ...request, body: new Uint8Array(16385), headers: await signed() }),
    ).rejects.toMatchObject({ code: "AUTH_BODY_TOO_LARGE", status: 413 });
    expect(writes()).toBe(0);
  });
  it("does not authorize requests with only a deployment-protection bypass header", async () => {
    await expect(
      receiver().auth.verify({
        ...request,
        headers: new Headers({ "x-vercel-protection-bypass": "fixture-bypass" }),
      }),
    ).rejects.toMatchObject({ code: "AUTH_HEADERS_INVALID", status: 401 });
  });
  it("fails closed when nonce persistence is unavailable without leaking its error", async () => {
    const auth = createAuthenticator({
      environment: "staging",
      direction: "cf-to-node",
      allowedExecutorVersions: ["build-new"],
      keys: new Map([["new", key]]),
      now: () => time,
      consumeNonce: async () => {
        throw new Error("private-token-body-prompt");
      },
    });
    await expect(auth.verify({ ...request, headers: await signed() })).rejects.toMatchObject({
      code: "AUTH_STORE_UNAVAILABLE",
      message: "AUTH_STORE_UNAVAILABLE",
      status: 503,
    });
  });
  it("authenticates every node-to-CF gate route with a direction-specific signature", async () => {
    for (const action of ["reserve", "consume", "report"]) {
      const gate = { ...request, url: `https://fixture.example/v1/gate/${action}` };
      const auth = createAuthenticator({
        environment: "staging",
        direction: "node-to-cf",
        allowedExecutorVersions: ["build-new"],
        keys: new Map([["new", key]]),
        now: () => time,
        consumeNonce: async () => true,
      });
      expect(
        (await auth.verify({ ...gate, headers: await signed({ direction: "node-to-cf" }, gate) }))
          .direction,
      ).toBe("node-to-cf");
    }
  });
  it("cryptographically binds all metadata even when the changed values remain allowed", async () => {
    for (const [name, value] of [
      ["x-upto-key-id", "old"],
      ["x-upto-executor-version", "build-old"],
      ["x-upto-issued-at", String(time + 1)],
      ["x-upto-expires-at", String(time + 59999)],
      ["x-upto-request-id", "00000000-0000-4000-8000-000000000003"],
      ["x-upto-nonce", "00000000-0000-4000-8000-000000000004"],
    ]) {
      const headers = await signed();
      headers.set(name!, value!);
      const { auth, writes } = receiver();
      await expect(auth.verify({ ...request, headers })).rejects.toMatchObject({
        code: "AUTH_SIGNATURE_INVALID",
      });
      expect(writes()).toBe(0);
    }
  });
  it("requires TLS outside the loopback fixture server", async () => {
    await expect(
      signed({}, { ...request, url: "http://fixture.example/api/v1/extract" }),
    ).rejects.toMatchObject({ code: "AUTH_ROUTE_INVALID" });
    expect(
      await signed({}, { ...request, url: "http://127.0.0.1:8888/api/v1/extract" }),
    ).toBeInstanceOf(Headers);
  });
  it("refuses overlong signature lifetimes and accepts the exact body-size limit", async () => {
    await expect(signed({ expiresAt: time + 60001 })).rejects.toThrow(
      "AUTH_SIGNING_CONTEXT_INVALID",
    );
    const bounded = { ...request, body: new Uint8Array(16384) };
    expect(
      (await receiver().auth.verify({ ...bounded, headers: await signed({}, bounded) })).nonce,
    ).toBe(context.nonce);
  });
  it("rejects weak or absent configuration at startup", () => {
    expect(() =>
      createAuthenticator({
        environment: "staging",
        direction: "cf-to-node",
        allowedExecutorVersions: [],
        keys: new Map([["new", key]]),
        consumeNonce: async () => true,
      }),
    ).toThrow("AUTH_CONFIGURATION_INVALID");
    expect(() =>
      createAuthenticator({
        environment: "staging",
        direction: "cf-to-node",
        allowedExecutorVersions: ["build-new"],
        keys: new Map([["new", new Uint8Array(4)]]),
        consumeNonce: async () => true,
      }),
    ).toThrow("AUTH_CONFIGURATION_INVALID");
  });
});
