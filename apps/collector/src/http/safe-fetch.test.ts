import { describe, expect, it } from "vitest";

import { createSafeFetcher, isPublicAddress } from "./safe-fetch.js";
describe("outbound fetch policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])("refuses non-public %s", (address) => expect(isPublicAddress(address)).toBe(false));
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("permits public %s", (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
  it("pins a validated DNS address and rejects mixed public/private answers", async () => {
    let calls = 0;
    const fetcher = createSafeFetcher({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      connect: async (_url, address) => {
        calls++;
        expect(address.address).toBe("8.8.8.8");
        return new Response("fixture");
      },
    });
    expect(await (await fetcher("https://fixture.example")).text()).toBe("fixture");
    expect(calls).toBe(1);
    const unsafe = createSafeFetcher({
      resolve: async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      connect: async () => {
        throw new Error("must not connect");
      },
    });
    await expect(unsafe("https://fixture.example")).rejects.toThrow("FETCH_ADDRESS_REJECTED");
  });
  it("rechecks redirect destinations before connecting", async () => {
    let calls = 0;
    const fetcher = createSafeFetcher({
      resolve: async (host) => [
        { address: host === "fixture.example" ? "8.8.8.8" : "127.0.0.1", family: 4 },
      ],
      connect: async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://private.example" },
        });
      },
    });
    await expect(fetcher("https://fixture.example")).rejects.toThrow("FETCH_ADDRESS_REJECTED");
    expect(calls).toBe(1);
  });
  it("enforces scheme, credentials, redirect and byte limits", async () => {
    const fetcher = createSafeFetcher({
      maxBytes: 3,
      maxRedirects: 1,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      connect: async (url) =>
        url.pathname === "/large"
          ? new Response("xxxx")
          : new Response(null, { status: 302, headers: { location: "/again" } }),
    });
    await expect(fetcher("http://fixture.example")).rejects.toThrow("FETCH_URL_REJECTED");
    await expect(fetcher("https://user:secret@fixture.example")).rejects.toThrow(
      "FETCH_URL_REJECTED",
    );
    await expect(fetcher("https://fixture.example/large")).rejects.toThrow("FETCH_BODY_TOO_LARGE");
    await expect(fetcher("https://fixture.example")).rejects.toThrow("FETCH_REDIRECT_LIMIT");
  });
  it("aborts on timeout and waits for the transport to settle", async () => {
    let settled = false;
    const fetcher = createSafeFetcher({
      timeoutMs: 50,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      connect: async (_url, _address, signal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              settled = true;
              resolve();
            },
            { once: true },
          ),
        );
        throw new Error("private-token");
      },
    });
    await expect(fetcher("https://fixture.example")).rejects.toThrow("FETCH_TIMEOUT");
    expect(settled).toBe(true);
  });
});
