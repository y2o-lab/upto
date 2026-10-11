import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

type Address = { address: string; family: 4 | 6 };
const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  denied.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  denied.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !denied.check(address, "ipv4")
    : family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}
async function resolveAddress(hostname: string): Promise<Address[]> {
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) === 4 ? 4 : 6 }];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => {
    if (record.family !== 4 && record.family !== 6) throw new Error("FETCH_ADDRESS_REJECTED");
    return { address: record.address, family: record.family };
  });
}
export async function requestPinned(
  url: URL,
  address: Address,
  signal: AbortSignal,
  maxBytes: number,
  headers: Headers,
  ca?: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        ...(ca === undefined ? {} : { ca }),
        agent: false,
        family: address.family,
        signal,
        headers: Object.fromEntries(headers),
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        async function read() {
          const status = response.statusCode ?? 502;
          if ([301, 302, 303, 307, 308].includes(status)) {
            response.destroy();
            return new Response(null, {
              status,
              headers: { location: response.headers.location ?? "" },
            });
          }
          const encoding = response.headers["content-encoding"]?.toLowerCase();
          const decoder =
            encoding === "gzip"
              ? createGunzip()
              : encoding === "deflate"
                ? createInflate()
                : encoding === "br"
                  ? createBrotliDecompress()
                  : null;
          if (encoding && encoding !== "identity" && !decoder)
            throw new Error("FETCH_ENCODING_REJECTED");
          let rawBytes = 0;
          response.on("data", (chunk: Buffer) => {
            rawBytes += chunk.length;
            if (rawBytes > maxBytes) response.destroy(new Error("FETCH_BODY_TOO_LARGE"));
          });
          if (decoder) response.on("error", (error) => decoder.destroy(error));
          const stream = decoder ? response.pipe(decoder) : response;
          const parts: Buffer[] = [];
          let size = 0;
          try {
            for await (const part of stream) {
              const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
              size += bytes.length;
              if (size > maxBytes) throw new Error("FETCH_BODY_TOO_LARGE");
              parts.push(bytes);
            }
            return new Response([204, 205, 304].includes(status) ? null : Buffer.concat(parts), {
              status,
              headers: {
                "content-type": String(
                  response.headers["content-type"] ?? "application/octet-stream",
                ),
              },
            });
          } finally {
            response.destroy();
            decoder?.destroy();
          }
        }
        void read().then(resolve, (error) => {
          response.destroy();
          reject(error);
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}
export function createSafeFetcher(
  options: {
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    resolve?: (host: string) => Promise<Address[]>;
    connect?: (
      url: URL,
      address: Address,
      signal: AbortSignal,
      maxBytes: number,
      headers: Headers,
    ) => Promise<Response>;
  } = {},
): typeof fetch {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 20000;
  const maxRedirects = options.maxRedirects ?? 5;
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 2 * 1024 * 1024 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 20000 ||
    !Number.isInteger(maxRedirects) ||
    maxRedirects < 0 ||
    maxRedirects > 5
  )
    throw new Error("FETCH_CONFIGURATION_INVALID");
  return async (input, init) => {
    if (input instanceof Request || (init?.method && init.method !== "GET") || init?.body)
      throw new Error("FETCH_REQUEST_REJECTED");
    const controller = new AbortController();
    const signal = init?.signal
      ? AbortSignal.any([controller.signal, init.signal])
      : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const supplied = new Headers(init?.headers);
    const headers = new Headers({
      accept: supplied.get("accept") ?? "*/*",
      "user-agent": supplied.get("user-agent") ?? "UptoCollector/0.1",
      "accept-encoding": "identity",
    });
    try {
      let url = new URL(String(input));
      for (let redirects = 0; ; redirects++) {
        if (signal.aborted) throw new Error("FETCH_TIMEOUT");
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          (url.port && url.port !== "443") ||
          url.hash ||
          url.hostname.endsWith(".localhost")
        )
          throw new Error("FETCH_URL_REJECTED");
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = await (options.resolve ?? resolveAddress)(hostname);
        if (signal.aborted) throw new Error("FETCH_TIMEOUT");
        if (
          !addresses.length ||
          addresses.some(
            (value) => !isPublicAddress(value.address) || isIP(value.address) !== value.family,
          )
        )
          throw new Error("FETCH_ADDRESS_REJECTED");
        const response = await (options.connect ?? requestPinned)(
          url,
          addresses[0]!,
          signal,
          maxBytes,
          headers,
        );
        if (signal.aborted) {
          await response.body?.cancel();
          throw new Error("FETCH_TIMEOUT");
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (redirects >= maxRedirects) throw new Error("FETCH_REDIRECT_LIMIT");
          const location = response.headers.get("location");
          if (!location) throw new Error("FETCH_REDIRECT_INVALID");
          url = new URL(location, url);
          continue;
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > maxBytes) throw new Error("FETCH_BODY_TOO_LARGE");
        return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
          status: response.status,
          headers: response.headers,
        });
      }
    } catch (error) {
      if (signal.aborted) throw new Error("FETCH_TIMEOUT");
      if (
        error instanceof Error &&
        [
          "FETCH_URL_REJECTED",
          "FETCH_ADDRESS_REJECTED",
          "FETCH_REDIRECT_LIMIT",
          "FETCH_REDIRECT_INVALID",
          "FETCH_BODY_TOO_LARGE",
          "FETCH_ENCODING_REJECTED",
          "FETCH_REQUEST_REJECTED",
        ].includes(error.message)
      )
        throw error;
      throw new Error("FETCH_TRANSPORT_FAILED");
    } finally {
      clearTimeout(timer);
    }
  };
}
