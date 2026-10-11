import { z } from "zod";

import { environmentSchema, hashSchema, MAX_CONTROL_REQUEST_BYTES } from "./contracts.js";

export const SIGNATURE_TTL_MS = 60000;
export const SIGNATURE_SKEW_MS = 5000;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const contextSchema = z.strictObject({
  authVersion: z.literal("v1"),
  direction: z.enum(["cf-to-node", "node-to-cf"]),
  environment: environmentSchema,
  keyId: identifier,
  executorVersion: identifier,
  requestId: z.uuid(),
  nonce: z.uuid(),
  issuedAt: timestamp,
  expiresAt: timestamp,
});
export type AuthContext = z.infer<typeof contextSchema>;
export type SignedRequestInput = { method: string; url: string; body: Uint8Array };
export type NonceInput = {
  environment: AuthContext["environment"];
  direction: AuthContext["direction"];
  keyId: string;
  nonce: string;
  retainUntil: Date;
};
export class RequestAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: 401 | 403 | 413 | 503,
  ) {
    super(code);
  }
}
const headersByField = {
  authVersion: "x-upto-auth-version",
  direction: "x-upto-direction",
  environment: "x-upto-environment",
  keyId: "x-upto-key-id",
  executorVersion: "x-upto-executor-version",
  requestId: "x-upto-request-id",
  nonce: "x-upto-nonce",
  issuedAt: "x-upto-issued-at",
  expiresAt: "x-upto-expires-at",
} as const;
const signatureHeader = "x-upto-signature";
const nodeRoutes = new Map([
  ["/api/v1/prepare", "POST"],
  ["/api/v1/discovery", "POST"],
  ["/api/v1/extract", "POST"],
  ["/api/v1/summarize-chunk", "POST"],
  ["/api/v1/merge-summary", "POST"],
  ["/api/v1/persist", "POST"],
  ["/api/v1/job-finalize", "POST"],
  ["/api/v1/manifests", "GET"],
  ["/api/v1/operation-status", "GET"],
]);
const gateRoutes = new Map([
  ["/v1/gate/reserve", "POST"],
  ["/v1/gate/consume", "POST"],
  ["/v1/gate/report", "POST"],
]);
function parseUrl(input: SignedRequestInput, direction: AuthContext["direction"]): URL {
  if (input.body.byteLength > MAX_CONTROL_REQUEST_BYTES)
    throw new RequestAuthError("AUTH_BODY_TOO_LARGE", 413);
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new RequestAuthError("AUTH_ROUTE_INVALID", 403);
  }
  const routes = direction === "cf-to-node" ? nodeRoutes : gateRoutes;
  if (
    url.hash ||
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) ||
    input.url.length > 4096 ||
    routes.get(url.pathname) !== input.method
  )
    throw new RequestAuthError("AUTH_ROUTE_INVALID", 403);
  return url;
}
function canonicalQuery(url: URL): string {
  // Stable key sort preserves the order of duplicate values. The HTTP adapter rejects duplicates.
  return [...url.searchParams]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}
async function signingBytes(
  input: SignedRequestInput,
  context: AuthContext,
): Promise<Uint8Array<ArrayBuffer>> {
  const url = parseUrl(input, context.direction);
  const bodyHash = await crypto.subtle.digest("SHA-256", new Uint8Array(input.body));
  const hash = Array.from(new Uint8Array(bodyHash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return new TextEncoder().encode(
    JSON.stringify([
      context.authVersion,
      context.direction,
      input.method,
      url.pathname,
      canonicalQuery(url),
      hash,
      context.requestId,
      context.nonce,
      context.issuedAt,
      context.expiresAt,
      context.environment,
      context.keyId,
      context.executorVersion,
    ]),
  );
}
function validDuration(context: AuthContext): boolean {
  return (
    context.expiresAt > context.issuedAt && context.expiresAt - context.issuedAt <= SIGNATURE_TTL_MS
  );
}
async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.byteLength < 32) throw new Error("AUTH_CONFIGURATION_INVALID");
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signRequest(
  input: SignedRequestInput,
  rawContext: AuthContext,
  key: Uint8Array,
): Promise<Headers> {
  const parsed = contextSchema.safeParse(rawContext);
  if (!parsed.success || !validDuration(parsed.data))
    throw new Error("AUTH_SIGNING_CONTEXT_INVALID");
  const context = parsed.data;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importKey(key),
    await signingBytes(input, context),
  );
  const headers = new Headers();
  for (const field of Object.keys(headersByField) as (keyof AuthContext)[])
    headers.set(headersByField[field], String(context[field]));
  headers.set(
    signatureHeader,
    Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
  return headers;
}
function readContext(headers: Headers): AuthContext {
  const values: Record<string, unknown> = {};
  for (const field of Object.keys(headersByField) as (keyof AuthContext)[])
    values[field] = headers.get(headersByField[field]);
  for (const field of ["issuedAt", "expiresAt"] as const) {
    const value = values[field];
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,15})$/.test(value))
      throw new RequestAuthError("AUTH_HEADERS_INVALID", 401);
    values[field] = Number(value);
  }
  const parsed = contextSchema.safeParse(values);
  if (!parsed.success) throw new RequestAuthError("AUTH_HEADERS_INVALID", 401);
  return parsed.data;
}
export function createAuthenticator(options: {
  environment: AuthContext["environment"];
  direction: AuthContext["direction"];
  allowedExecutorVersions: readonly string[];
  keys: ReadonlyMap<string, Uint8Array>;
  consumeNonce: (input: NonceInput) => Promise<boolean>;
  now?: () => number;
}) {
  if (
    !environmentSchema.safeParse(options.environment).success ||
    !["cf-to-node", "node-to-cf"].includes(options.direction) ||
    options.allowedExecutorVersions.length === 0 ||
    options.allowedExecutorVersions.some((value) => !identifier.safeParse(value).success) ||
    options.keys.size === 0 ||
    [...options.keys].some(([id, key]) => !identifier.safeParse(id).success || key.byteLength < 32)
  )
    throw new Error("AUTH_CONFIGURATION_INVALID");
  // Snapshot rotation configuration to prevent mutation by callers during a request.
  const keys = new Map([...options.keys].map(([id, key]) => [id, new Uint8Array(key)]));
  const versions = new Set(options.allowedExecutorVersions);
  return {
    async verify(input: SignedRequestInput & { headers: Headers }): Promise<AuthContext> {
      if (input.body.byteLength > MAX_CONTROL_REQUEST_BYTES)
        throw new RequestAuthError("AUTH_BODY_TOO_LARGE", 413);
      const context = readContext(input.headers);
      if (
        context.environment !== options.environment ||
        context.direction !== options.direction ||
        !versions.has(context.executorVersion)
      )
        throw new RequestAuthError("AUTH_SCOPE_INVALID", 403);
      const key = keys.get(context.keyId);
      if (!key) throw new RequestAuthError("AUTH_KEY_UNKNOWN", 401);
      const now = (options.now ?? Date.now)();
      if (
        !Number.isSafeInteger(now) ||
        !validDuration(context) ||
        now < context.issuedAt - SIGNATURE_SKEW_MS ||
        now >= context.expiresAt + SIGNATURE_SKEW_MS
      )
        throw new RequestAuthError("AUTH_TIME_INVALID", 401);
      const signature = input.headers.get(signatureHeader);
      if (!hashSchema.safeParse(signature).success || signature === null)
        throw new RequestAuthError("AUTH_HEADERS_INVALID", 401);
      const signatureBytes = Uint8Array.from(signature.match(/../g) ?? [], (value) =>
        Number.parseInt(value, 16),
      );
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          await importKey(key),
          signatureBytes,
          await signingBytes(input, context),
        ))
      )
        throw new RequestAuthError("AUTH_SIGNATURE_INVALID", 401);
      let accepted: boolean;
      try {
        accepted = await options.consumeNonce({
          environment: context.environment,
          direction: context.direction,
          keyId: context.keyId,
          nonce: context.nonce,
          retainUntil: new Date(context.expiresAt + SIGNATURE_SKEW_MS),
        });
      } catch {
        throw new RequestAuthError("AUTH_STORE_UNAVAILABLE", 503);
      }
      if (!accepted) throw new RequestAuthError("AUTH_REPLAY", 401);
      return context;
    },
  };
}
